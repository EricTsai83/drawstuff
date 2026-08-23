import { MAX_ROOM_TOKEN_BYTES } from "@drawstuff/collaboration/room-auth";
import {
  MIN_ROOM_TOKEN_SECRET_BYTES,
  verifyRoomControlToken,
} from "@drawstuff/collaboration/room-token";
import { z } from "zod";

import {
  closedJsonResponse,
  INTERNAL_AUTH_GENERATION_HEADER,
  INTERNAL_ROOM_ID_HEADER,
  parseSocketRouteIdentity,
} from "./internal.ts";

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
 *   POST /v1/control                                           (Vercel only)
 */

const HEALTH_PATH = "/healthz";
const CONTROL_PATH = "/v1/control";
const SOCKET_ROUTE_PATTERN =
  /^\/v1\/rooms\/([^/]+)\/generations\/([^/]+)\/socket$/;

/**
 * A control body is one token in a JSON envelope; anything materially larger
 * is rejected before buffering.
 */
const MAX_CONTROL_BODY_BYTES = 2_048;

/** Control bodies carry exactly one token; unknown keys fail closed. */
const controlRequestSchema = z.strictObject({
  token: z.string().min(1).max(MAX_ROOM_TOKEN_BYTES),
});

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
  // Exception boundary: every failure maps to a closed response. Detail goes
  // to Workers Logs, never to the client, and the gateway never retries —
  // WebSocket upgrades are not retryable and control retries belong to the
  // Plan 11 durable dispatcher.
  try {
    const url = new URL(request.url);
    if (url.pathname === HEALTH_PATH) return handleHealth(request, env);
    if (url.pathname === CONTROL_PATH) return await handleControl(request, env);
    const socketMatch = SOCKET_ROUTE_PATTERN.exec(url.pathname);
    if (socketMatch !== null) {
      return await handleSocket(
        request,
        env,
        socketMatch[1] ?? "",
        socketMatch[2] ?? "",
      );
    }
    return closedJsonResponse(404, "not-found");
  } catch (error) {
    console.error("gateway: unhandled failure", error);
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
    roomTokenSecret: roomTokenSecretReady(env.COLLAB_JOIN_TOKEN_SECRET),
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
  roomIdSegment: string,
  generationSegment: string,
): Promise<Response> {
  // Identity segments are parsed with the canonical grammar before anything
  // else; a malformed room or generation is an unknown resource, full stop.
  const identity = parseSocketRouteIdentity(roomIdSegment, generationSegment);
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
    console.error("gateway: COLLAB_ALLOWED_ORIGINS is malformed");
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
    console.error("gateway: room object fetch failed", error);
    return closedJsonResponse(503, "unavailable");
  }
}

async function handleControl(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return closedJsonResponse(405, "method-not-allowed", { Allow: "POST" });
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return closedJsonResponse(415, "unsupported-media-type");
  }

  const body = await readBoundedBody(request, MAX_CONTROL_BODY_BYTES);
  if (body === undefined) return closedJsonResponse(413, "payload-too-large");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return closedJsonResponse(400, "malformed");
  }
  const controlRequest = controlRequestSchema.safeParse(parsedJson);
  if (!controlRequest.success) return closedJsonResponse(400, "malformed");

  const secret = env.COLLAB_JOIN_TOKEN_SECRET;
  if (!roomTokenSecretReady(secret)) {
    console.error("gateway: room token secret is missing or too short");
    return closedJsonResponse(503, "not-ready");
  }

  const verified = verifyRoomControlToken({
    token: controlRequest.data.token,
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) {
    // The reason is log-only; the response never distinguishes failure modes.
    console.warn("gateway: control token rejected", {
      reason: verified.reason,
    });
    return closedJsonResponse(401, "unauthorized");
  }

  // Plan 11 dispatches the verified action to the Object as versioned typed
  // RPC; until that exists the gateway refuses rather than improvising.
  return closedJsonResponse(501, "control-dispatch-unimplemented");
}

/**
 * Buffers at most `maxBytes`; returns `undefined` the moment the body runs
 * past the bound, without reading the rest.
 */
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
