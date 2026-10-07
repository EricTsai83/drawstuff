import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ASSET_GATEWAY_PATH,
  AUTHORITY_LIMITS,
  assetGatewayResultSchema,
  type AssetRequest,
} from "@drawstuff/collaboration/authority";

/** Capability-authenticated metadata only. */
export async function callAssetGateway(
  config: { url: string; secret: string },
  proof: string,
  request: AssetRequest,
  fetchImpl: typeof fetch = fetch,
) {
  const endpoint = new URL(ASSET_GATEWAY_PATH, config.url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    config.secret.length < 32
  )
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
  const body = JSON.stringify({ proof, request });
  if (new TextEncoder().encode(body).byteLength > AUTHORITY_LIMITS.jobBytes)
    throw new TRPCError({ code: "BAD_REQUEST" });
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(AUTHORITY_LIMITS.externalTimeoutMs),
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
      });
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.startsWith("application/json")
    ) {
      await response.body?.cancel();
      throw new Error("invalid-response");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0,
      json = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > AUTHORITY_LIMITS.jobBytes)
          throw new Error("response-too-large");
        json += decoder.decode(chunk.value, { stream: true });
      }
      json += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const result = z
      .strictObject({ ok: z.literal(true), result: assetGatewayResultSchema })
      .parse(JSON.parse(json) as unknown).result;
    if (
      request.action === "read"
        ? !("roomId" in result) || result.roomId !== request.roomId
        : "roomId" in result
    )
      throw new Error("invalid-response");
    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Attachment result is unknown. Query the original operation.",
    });
  }
}
