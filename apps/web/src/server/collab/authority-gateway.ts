import "server-only";
import { TRPCError } from "@trpc/server";
import {
  AUTHORITY_GATEWAY_PATH,
  AUTHORITY_LIMITS,
  authorityGatewayResponseSchema,
  type AuthorityRequest,
} from "@drawstuff/collaboration/authority";
import {
  ROOM_KEY_GATEWAY_PATH,
  roomKeyGatewayResponseSchema,
  type RoomKeyRequest,
  type RoomKeyResult,
} from "@drawstuff/collaboration/key-custody";

/**
 * Posts one bounded JSON request to a Room Gateway path and returns its parsed
 * body. Failures never imply that a Room transaction did not commit.
 */
async function postToGateway(
  config: { url: string; secret: string },
  path: string,
  payload: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = new URL(path, config.url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    config.secret.length < 32
  )
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Collaboration authority is unavailable.",
    });
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > AUTHORITY_LIMITS.jobBytes)
    throw new TRPCError({ code: "BAD_REQUEST" });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${config.secret}`,
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.any([
      AbortSignal.timeout(AUTHORITY_LIMITS.externalTimeoutMs),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TRPCError({
      code:
        response.status === 403
          ? "FORBIDDEN"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status === 409
              ? "PRECONDITION_FAILED"
              : "SERVICE_UNAVAILABLE",
      message:
        "Collaboration request was not confirmed. Query or retry the same operation.",
    });
  }
  if (
    !response.headers.get("content-type")?.startsWith("application/json") ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("invalid-response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let json = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > AUTHORITY_LIMITS.jobBytes)
        throw new Error("response-too-large");
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(json) as unknown;
}

/** Any failure other than Room's own refusal is reported as unconfirmed. */
function unconfirmed(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message:
      "Collaboration request was not confirmed. Query or retry the same operation.",
  });
}

/** A retry reuses the original operationId. HTTP failure never implies that a Room transaction did not commit. */
export async function callAuthorityGateway(
  config: { url: string; secret: string },
  proof: string,
  request: AuthorityRequest,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  try {
    const result = authorityGatewayResponseSchema.parse(
      await postToGateway(
        config,
        AUTHORITY_GATEWAY_PATH,
        { proof, request },
        fetchImpl,
        signal,
      ),
    ).result;
    if (
      request.action === "get-state" || request.action === "get-management"
        ? !("roomId" in result) || result.roomId !== request.roomId
        : !("operationId" in result) ||
          result.operationId !== request.operationId
    )
      throw new Error("invalid-response");
    return result;
  } catch (error) {
    unconfirmed(error);
  }
}

/**
 * Room key custody (plan 19). Kept apart from `callAuthorityGateway` so no
 * generic authority result can ever carry a key.
 */
export async function callRoomKeyGateway(
  config: { url: string; secret: string },
  proof: string,
  request: RoomKeyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RoomKeyResult> {
  try {
    const result = roomKeyGatewayResponseSchema.parse(
      await postToGateway(
        config,
        ROOM_KEY_GATEWAY_PATH,
        { proof, request },
        fetchImpl,
      ),
    ).result;
    if (result.roomId !== request.roomId) throw new Error("invalid-response");
    return result;
  } catch (error) {
    unconfirmed(error);
  }
}
