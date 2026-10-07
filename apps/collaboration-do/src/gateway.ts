import { MIN_ROOM_TOKEN_SECRET_BYTES } from "@drawstuff/collaboration/room-token";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import {
  LIFECYCLE_GATEWAY_PATH,
  lifecycleGatewayRequestSchema,
  lifecycleObjectName,
  AUTHORITY_GATEWAY_PATH,
  AUTHORITY_LIMITS,
  authorityGatewayRequestSchema,
  snapshotGatewayRequestSchema,
  SNAPSHOT_GATEWAY_PATH,
  SNAPSHOT_REQUEST_HEADER,
  ADAPTER_METADATA_MAX_BYTES,
  ASSET_GATEWAY_PATH,
  assetGatewayRequestSchema,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";

import {
  closedJsonResponse,
  INTERNAL_AUTH_GENERATION_HEADER,
  INTERNAL_ROOM_ID_HEADER,
  INTERNAL_AUTHORITY_SOCKET_HEADER,
  parseSocketRouteIdentity,
} from "./internal.ts";
import { createDoLogger, errorNameOf, type DoLogger } from "./logger.ts";

/**
 * Thin gateway (CLAIM-MIG-1): Durable Objects accept no Internet requests, so
 * this Worker is the only ingress. It validates the public request shape,
 * resolves the routing identity, verifies control tokens, and hands one
 * Object one request via its binding. It is not a second backend: no data
 * authority, no proxying to arbitrary targets, no debug or storage surface.
 *
 * Fixed, versioned public surface — nothing else resolves:
 *
 *   GET  /healthz
 *   GET  /v1/rooms/:roomId/generations/:authGeneration/socket  (Upgrade only)
 *   GET  /v1/rooms/:roomId/socket                               (identity proof join)
 *   POST /v1/control                                           (Vercel only)
 *   POST /v1/authority                                         (Vercel only)
 *   POST /v1/snapshot                                          (Vercel only)
 *   POST /v1/assets                                            (Vercel only)
 */

const HEALTH_PATH = "/healthz";
const AUTHORITY_SOCKET_ROUTE_PATTERN = /^\/v1\/rooms\/([^/]+)\/socket$/;

/**
 * The allowlist var is a comma-separated string ("" means: nothing allowed,
 * fail closed) so every environment resolves to the same generated type.
 */
const allowedOriginsSchema = z.array(z.url());

const encoder = new TextEncoder();

function roomTokenSecretReady(secret: string | undefined): secret is string {
  return (
    typeof secret === "string" &&
    encoder.encode(secret).byteLength >= MIN_ROOM_TOKEN_SECRET_BYTES
  );
}

/** Parsed allowlist, or `undefined` when the var is malformed (fail closed). */
function allowedOrigins(env: Env): readonly string[] | undefined {
  if (typeof env.COLLAB_ALLOWED_ORIGINS !== "string") return undefined;
  const entries = env.COLLAB_ALLOWED_ORIGINS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const parsed = allowedOriginsSchema.safeParse(entries);
  return parsed.success ? parsed.data : undefined;
}

export async function handleGatewayRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const log = createDoLogger(env.VERSION_METADATA);
  // Exception boundary: every failure maps to a closed response. Detail goes
  // to Workers Logs, never to the client, and the gateway never retries —
  // WebSocket upgrades are not retryable and control retries belong to the
  // durable control dispatcher.
  try {
    const url = new URL(request.url);
    if (url.pathname === HEALTH_PATH) return handleHealth(request, env);
    if (url.pathname === LIFECYCLE_GATEWAY_PATH)
      return await handleLifecycle(request, env);
    if (url.pathname === AUTHORITY_GATEWAY_PATH)
      return await handleAuthority(request, env);
    if (url.pathname === SNAPSHOT_GATEWAY_PATH)
      return await handleSnapshot(request, env);
    if (url.pathname === ASSET_GATEWAY_PATH)
      return await handleAuthority(request, env, true);
    const authoritySocket = AUTHORITY_SOCKET_ROUTE_PATTERN.exec(url.pathname);
    if (authoritySocket)
      return await handleSocket(request, env, log, authoritySocket[1]!);
    return closedJsonResponse(404, "not-found");
  } catch (error) {
    log.error("gateway.unhandled_failure", { errorName: errorNameOf(error) });
    return closedJsonResponse(500, "internal");
  }
}

/**
 * Reports Worker/version/config readiness only. Deliberately never calls or
 * creates a Durable Object: a health probe must not decide Object placement
 * (CLAIM-MIG-5) and must stay cheap under monitoring frequency.
 */
function handleHealth(request: Request, env: Env): Response {
  if (request.method !== "GET") {
    return closedJsonResponse(405, "method-not-allowed", { Allow: "GET" });
  }
  const ready = {
    roomTokenSecret: roomTokenSecretReady(env.COLLAB_IDENTITY_SECRET),
    allowedOrigins: allowedOrigins(env) !== undefined,
  };
  return Response.json({
    ok: ready.roomTokenSecret && ready.allowedOrigins,
    version: {
      id: env.VERSION_METADATA.id,
      tag: env.VERSION_METADATA.tag,
    },
    ready,
  });
}

async function handleSocket(
  request: Request,
  env: Env,
  log: DoLogger,
  roomIdSegment: string,
): Promise<Response> {
  // Identity segments are parsed with the canonical grammar before anything
  // else; a malformed room or generation is an unknown resource, full stop.
  const identity = parseSocketRouteIdentity(roomIdSegment, "1");
  if (identity === undefined) return closedJsonResponse(404, "not-found");

  if (request.method !== "GET") {
    return closedJsonResponse(405, "method-not-allowed", { Allow: "GET" });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return closedJsonResponse(426, "upgrade-required", {
      Upgrade: "websocket",
    });
  }

  // Origin is defense-in-depth on top of the join token (which stays in the
  // first bounded control frame — never in the query, path, cookie or logs).
  // A misconfigured allowlist fails closed rather than open.
  const origins = allowedOrigins(env);
  if (origins === undefined) {
    log.error("gateway.config_invalid");
    return closedJsonResponse(503, "not-ready");
  }
  const origin = request.headers.get("Origin");
  if (origin === null || !origins.includes(origin)) {
    return closedJsonResponse(403, "forbidden");
  }

  // Strip the internal metadata names off the public request, then forward
  // the parsed identity under those names. The Object re-derives the
  // canonical RoomChannelKey and compares it to its own ctx.id.name.
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_ROOM_ID_HEADER);
  headers.delete(INTERNAL_AUTH_GENERATION_HEADER);
  headers.delete(INTERNAL_AUTHORITY_SOCKET_HEADER);
  headers.set(INTERNAL_AUTHORITY_SOCKET_HEADER, "1");
  headers.set(INTERNAL_ROOM_ID_HEADER, identity.roomId);
  headers.set(INTERNAL_AUTH_GENERATION_HEADER, String(identity.authGeneration));
  const internalRequest = new Request(request, { headers });

  // One RoomChannelKey, one Object (CLAIM-MIG-2): always getByName with the
  // canonical key — never idFromString, newUniqueId or a client-named target.
  const stub = env.COLLABORATION_ROOM.getByName(identity.channelKey);
  try {
    return await stub.fetch(internalRequest);
  } catch (error) {
    // Retryable infrastructure failure maps to a closed 503; the WebSocket
    // upgrade is never retried at the gateway.
    //
    // Deliberately no room identifiers: the join token is verified inside the
    // Object, so at this point the route is still unverified client input.
    // A room id and a room key share one alphabet and length range, so
    // recording an unverified route id here would be an exfiltration path for
    // anyone who can reach this endpoint (threat model, observability data
    // classification). The Object logs the verified identity once it has one.
    log.error("gateway.room_fetch_failed", {
      errorName: errorNameOf(error),
    });
    return closedJsonResponse(503, "unavailable");
  }
}

function serviceAuthorized(request: Request, env: Env): boolean {
  const secret = env.COLLAB_AUTHORITY_SECRET;
  const header = request.headers.get("authorization");
  const received = encoder.encode(
    header?.startsWith("Bearer ") ? header.slice(7) : "",
  );
  const expected = encoder.encode(secret ?? "");
  return (
    expected.byteLength >= 32 &&
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}

async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  if (!serviceAuthorized(request, env))
    return closedJsonResponse(401, "unauthorized");
  if (request.method !== "POST")
    return closedJsonResponse(405, "method-not-allowed", { Allow: "POST" });
  const metadata = request.headers.get(SNAPSHOT_REQUEST_HEADER);
  if (
    !metadata ||
    encoder.encode(metadata).byteLength > ADAPTER_METADATA_MAX_BYTES
  )
    return closedJsonResponse(400, "malformed");
  let input: unknown;
  try {
    input = JSON.parse(metadata) as unknown;
  } catch {
    return closedJsonResponse(400, "malformed");
  }
  const parsed = snapshotGatewayRequestSchema.safeParse(input);
  if (!parsed.success) return closedJsonResponse(400, "malformed");
  if (!roomTokenSecretReady(env.COLLAB_IDENTITY_SECRET))
    return closedJsonResponse(503, "not-ready");
  const intent =
    parsed.data.request.action === "read"
      ? parsed.data.request
      : parsed.data.request.operation;
  const verified = verifyIdentityProof({
    token: parsed.data.proof,
    secret: env.COLLAB_IDENTITY_SECRET,
    expectedRoomId: intent.roomId,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) return closedJsonResponse(401, "unauthorized");
  if (request.headers.get("content-type") !== "application/octet-stream")
    return closedJsonResponse(415, "unsupported-media-type");
  const maximum =
    parsed.data.request.action === "write" &&
    parsed.data.request.operation.kind === "snapshot-put"
      ? MAX_SNAPSHOT_CIPHERTEXT_BYTES
      : 0;
  if (Number(request.headers.get("content-length") ?? 0) > maximum)
    return closedJsonResponse(413, "payload-too-large");
  // Forward at most maximum+1 actual bytes: the extra byte makes an oversized stream
  // unambiguously fail the Object's own bound instead of silently truncating it.
  // Generated HTTP body types are unparameterized; HTTP chunks are bytes.
  const reader = request.body?.getReader() as
    ReadableStreamDefaultReader<Uint8Array> | undefined;
  let forwarded = 0;
  const body = reader
    ? new ReadableStream({
        type: "bytes",
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            const remaining = maximum + 1 - forwarded;
            const bytes =
              chunk.value.byteLength > remaining
                ? chunk.value.slice(0, remaining)
                : chunk.value;
            forwarded += bytes.byteLength;
            controller.enqueue(bytes);
            if (forwarded > maximum) {
              controller.close();
              await reader.cancel();
              reader.releaseLock();
            }
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await reader.cancel();
          reader.releaseLock();
        },
      })
    : null;
  const internal = new Request("https://room.internal/v1/snapshot", {
    method: "POST",
    headers: { [SNAPSHOT_REQUEST_HEADER]: metadata },
    body,
  });
  try {
    return await env.COLLABORATION_ROOM.getByName(
      intent.roomId,
    ).applySnapshotV1(internal);
  } catch {
    return closedJsonResponse(503, "unavailable");
  }
}

async function handleAuthority(
  request: Request,
  env: Env,
  assets = false,
): Promise<Response> {
  if (!serviceAuthorized(request, env))
    return closedJsonResponse(401, "unauthorized");
  if (request.method !== "POST")
    return closedJsonResponse(405, "method-not-allowed", { Allow: "POST" });
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return closedJsonResponse(415, "unsupported-media-type");
  const bytes = await readBoundedBody(request, AUTHORITY_LIMITS.jobBytes);
  if (!bytes) return closedJsonResponse(413, "payload-too-large");
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    return closedJsonResponse(400, "malformed");
  }
  const parsed = assets
    ? assetGatewayRequestSchema.safeParse(body)
    : authorityGatewayRequestSchema.safeParse(body);
  if (!parsed.success) return closedJsonResponse(400, "malformed");
  if (!roomTokenSecretReady(env.COLLAB_IDENTITY_SECRET))
    return closedJsonResponse(503, "not-ready");
  const roomId =
    "intent" in parsed.data.request
      ? parsed.data.request.intent.roomId
      : parsed.data.request.roomId;
  const verified = verifyIdentityProof({
    token: parsed.data.proof,
    secret: env.COLLAB_IDENTITY_SECRET,
    expectedRoomId: roomId,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) return closedJsonResponse(401, "unauthorized");
  try {
    const stub = env.COLLABORATION_ROOM.getByName(roomId);
    const result = assets
      ? await stub.applyAssetsV1(parsed.data)
      : await stub.applyAuthorityV1(parsed.data);
    if (!result.ok)
      return closedJsonResponse(
        result.error === "unavailable"
          ? 503
          : result.error === "not-found"
            ? 404
            : result.error === "unauthorized"
              ? 401
              : result.error === "forbidden"
                ? 403
                : 409,
        result.error,
      );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return closedJsonResponse(503, "unavailable");
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return undefined;
  }
  if (request.body === null) return new Uint8Array(0);

  // The workerd body stream is untyped (ReadableStream<any>); request bodies
  // are always byte streams.
  const reader =
    request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function handleLifecycle(request: Request, env: Env): Promise<Response> {
  if (!serviceAuthorized(request, env))
    return closedJsonResponse(401, "unauthorized");
  if (request.method !== "POST")
    return closedJsonResponse(405, "method-not-allowed");
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    return closedJsonResponse(415, "unsupported-media-type");
  const bytes = await readBoundedBody(request, AUTHORITY_LIMITS.jobBytes);
  if (!bytes) return closedJsonResponse(413, "payload-too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    return closedJsonResponse(400, "malformed");
  }
  const parsed = lifecycleGatewayRequestSchema.safeParse(raw);
  if (!parsed.success) return closedJsonResponse(400, "malformed");
  const input = parsed.data;
  try {
    if (input.action === "end-room")
      return Response.json(
        await env.COLLABORATION_ROOM.getByName(input.roomId).endAuthorityV1(
          input.operationId,
        ),
      );
    const stub = env.COLLABORATION_LIFECYCLE.getByName(
      lifecycleObjectName(
        input.action === "begin" ? input.command.target : input.target,
      ),
    );
    const result =
      input.action === "begin"
        ? await stub.begin(input.command)
        : await stub.query(input.operationId);
    if (!result) return closedJsonResponse(404, "not-found");
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return closedJsonResponse(503, "unavailable");
  }
}
