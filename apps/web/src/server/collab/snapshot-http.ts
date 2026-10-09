import "server-only";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ADAPTER_METADATA_MAX_BYTES,
  AUTHORITY_LIMITS,
  SNAPSHOT_GATEWAY_PATH,
  SNAPSHOT_RECEIPT_HEADER,
  SNAPSHOT_REQUEST_HEADER,
  authorityStateSchema,
  contentResultSchema,
  snapshotRequestSchema,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_BYTES } from "@drawstuff/collaboration/snapshot";
import { env } from "@/env";
import { auth } from "@/lib/auth";
import {
  SNAPSHOT_INTENT_HEADER,
  SnapshotHttpError,
  parseSnapshotHttpReceipt,
  readSnapshotHttpBody,
  readSnapshotHttpJson,
  snapshotHttpErrorSchema,
  waitForSnapshot,
} from "@/lib/collab/snapshot-http";
import { db } from "@/server/db";
import {
  checkCollaborationRateLimit,
  enforceCollaborationRateLimit,
  enforceCollaborationRateLimitDecision,
  rateLimitMetadataOf,
} from "@/server/rate-limit/collaboration";
import { issueAuthorityIdentity } from "./authority-identity";
import { callAuthorityGateway } from "./authority-gateway";
import { AdapterError } from "./authority-storage";
import { collaborationRoomsDisabled } from "./relay-routing";

const noStore = { "cache-control": "no-store" };
/**
 * Room refuses with `{ error }` (collaboration-do `closedJsonResponse`); the
 * browser-facing `{ ok: false, code }` shape is this route's own.
 */
const upstreamSnapshotErrorSchema = z.strictObject({
  error: snapshotHttpErrorSchema.shape.code,
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Preserve Room's chunk-time authorization; do not buffer the whole reply in web. */
function forwardSnapshotBody(
  body: ReadableStream<Uint8Array> | null,
  length: number,
  signal: AbortSignal,
  finish: () => void,
) {
  if (!body) throw new SnapshotHttpError(503, "unavailable");
  const reader = body.getReader();
  let received = 0;
  let closed = false;
  let abort: () => void;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    finish();
  };
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      abort = () => {
        controller.error(new Error("snapshot-unavailable"));
        close();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const chunk = await waitForSnapshot(reader.read(), signal);
        signal.throwIfAborted();
        if (chunk.done) {
          if (received !== length) throw new Error("snapshot-length-mismatch");
          controller.close();
          close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > length) throw new Error("snapshot-length-mismatch");
        controller.enqueue(chunk.value.slice());
      } catch {
        if (!closed) {
          controller.error(new Error("snapshot-unavailable"));
          close();
        }
      }
    },
    cancel: close,
  });
}

/** Public cookie-authenticated ingress; Room is the only source of room permissions. */
export async function handleSnapshotHttp(request: Request): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(),
    AUTHORITY_LIMITS.externalTimeoutMs,
  );
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  let streaming = false;
  let upstream: Response | undefined;
  const finish = () => clearTimeout(timer);
  try {
    if (request.method !== "POST")
      throw new SnapshotHttpError(400, "malformed");
    // Compare the configured origin, never Host/X-Forwarded-Host. Every action uses POST.
    if (
      request.headers.get("origin") !==
        new URL(env.NEXT_PUBLIC_BASE_URL).origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new SnapshotHttpError(403, "forbidden");
    if (
      collaborationRoomsDisabled() ||
      !env.COLLAB_IDENTITY_SECRET ||
      !env.COLLAB_AUTHORITY_SECRET
    )
      throw new SnapshotHttpError(503, "unavailable");
    const endpoint = new URL(SNAPSHOT_GATEWAY_PATH, env.COLLAB_CONTROL_URL);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      env.COLLAB_AUTHORITY_SECRET.length < 32 ||
      env.COLLAB_IDENTITY_SECRET.length < 32
    )
      throw new SnapshotHttpError(503, "unavailable");
    const metadata = request.headers.get(SNAPSHOT_REQUEST_HEADER);
    if (
      !metadata ||
      new TextEncoder().encode(metadata).byteLength >
        ADAPTER_METADATA_MAX_BYTES ||
      request.headers.get("content-type") !== "application/octet-stream"
    )
      throw new SnapshotHttpError(400, "malformed");
    let input: ReturnType<typeof snapshotRequestSchema.parse>;
    try {
      input = snapshotRequestSchema.parse(JSON.parse(metadata) as unknown);
    } catch {
      throw new SnapshotHttpError(400, "malformed");
    }
    const intent = request.headers.get(SNAPSHOT_INTENT_HEADER) ?? "cadence";
    if (intent !== "cadence" && intent !== "leave")
      throw new SnapshotHttpError(400, "malformed");
    const put =
      input.action === "write" && input.operation.kind === "snapshot-put";
    if (intent === "leave" && !put)
      throw new SnapshotHttpError(400, "malformed");
    const room = input.action === "read" ? input : input.operation;
    const session = await waitForSnapshot(
      auth.api.getSession({ headers: request.headers }),
      signal,
    );
    if (!session) throw new SnapshotHttpError(401, "unauthorized");
    await waitForSnapshot(
      enforceCollaborationRateLimit({
        operation: "snapshot-request",
        identifier: session.user.id,
      }),
      signal,
    );
    let proof: string;
    try {
      ({ proof } = await waitForSnapshot(
        issueAuthorityIdentity(
          db,
          {
            subject: session.user.id,
            sessionId: session.session.id,
            roomId: room.roomId,
          },
          env.COLLAB_IDENTITY_SECRET,
        ),
        signal,
      ));
    } catch (error) {
      throw new SnapshotHttpError(
        error instanceof AdapterError ? 403 : 503,
        error instanceof AdapterError ? "forbidden" : "unavailable",
      );
    }
    if (input.action === "write") {
      // Refuse outsiders before they can spend the shared room budget. The final
      // binary operation is separately authorized by Room after any intervening change.
      const state = authorityStateSchema.parse(
        await waitForSnapshot(
          callAuthorityGateway(
            {
              url: env.COLLAB_CONTROL_URL,
              secret: env.COLLAB_AUTHORITY_SECRET,
            },
            proof,
            {
              v: 1,
              action: "get-state",
              roomId: room.roomId,
              operationId: crypto.randomUUID(),
              deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
            },
            fetch,
            signal,
          ),
          signal,
        ),
      );
      if (
        state.role === "viewer" ||
        (input.operation.kind === "snapshot-reset" && state.role !== "owner")
      )
        throw new SnapshotHttpError(403, "forbidden");
      if (
        state.state === "ended" ||
        (state.state === "initializing" && state.role !== "owner")
      )
        throw new SnapshotHttpError(
          409,
          state.state === "ended" ? "ended" : "initializing",
        );
      const decision = await waitForSnapshot(
        checkCollaborationRateLimit({
          operation: "snapshot-put",
          identifier: room.roomId,
        }),
        signal,
      );
      if (decision.status === "limited" && intent === "leave")
        await waitForSnapshot(
          enforceCollaborationRateLimit({
            operation: "snapshot-finalize",
            identifier: JSON.stringify([room.roomId, session.user.id]),
          }),
          signal,
        );
      else enforceCollaborationRateLimitDecision(decision);
    }
    const bytes = await readSnapshotHttpBody(
      request.body,
      put ? MAX_SNAPSHOT_BYTES : 0,
      signal,
    );
    if (
      input.action === "write" &&
      (digest(bytes) !== input.operation.checksum ||
        (put && bytes.byteLength === 0))
    )
      throw new SnapshotHttpError(400, "invalid-body");
    const trustedMetadata = JSON.stringify({ proof, request: input });
    if (
      new TextEncoder().encode(trustedMetadata).byteLength >
      ADAPTER_METADATA_MAX_BYTES
    )
      throw new SnapshotHttpError(400, "malformed");
    upstream = await waitForSnapshot(
      fetch(endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          authorization: `Bearer ${env.COLLAB_AUTHORITY_SECRET}`,
          "content-type": "application/octet-stream",
          [SNAPSHOT_REQUEST_HEADER]: trustedMetadata,
        },
        body: bytes.buffer,
      }),
      signal,
    );
    if (
      input.action === "read" &&
      (upstream.status === 200 ||
        (upstream.status === 404 &&
          upstream.headers.has(SNAPSHOT_RECEIPT_HEADER)))
    ) {
      const result = parseSnapshotHttpReceipt(upstream, room.roomId);
      const headers = {
        ...noStore,
        [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(result.receipt),
      };
      if (!result.found) {
        const error = upstreamSnapshotErrorSchema.parse(
          await readSnapshotHttpJson(upstream, signal),
        );
        if (error.error !== "not-found") throw new Error("invalid-absence");
        return Response.json(
          { ok: false, code: "not-found" },
          { status: 404, headers },
        );
      }
      const body = forwardSnapshotBody(
        upstream.body,
        result.receipt.byteLength,
        signal,
        finish,
      );
      streaming = true;
      return new Response(body, {
        headers: { ...headers, "content-type": "application/octet-stream" },
      });
    }
    if (upstream.status !== 200) {
      const allowed = [400, 401, 403, 404, 409, 413, 429, 503];
      if (!allowed.includes(upstream.status)) throw new Error("invalid-status");
      const error = upstreamSnapshotErrorSchema.parse(
        await readSnapshotHttpJson(upstream, signal),
      );
      // Never forward upstream cookies, capabilities, arbitrary fields or headers.
      throw new SnapshotHttpError(upstream.status, error.error);
    }
    if (input.action === "read") throw new Error("invalid-response");
    const result = contentResultSchema.parse(
      await readSnapshotHttpJson(upstream, signal),
    );
    if (
      result.status === "written" &&
      result.revision !== input.operation.expectedRevision + 1
    )
      throw new Error("invalid-revision");
    return Response.json(result, { headers: noStore });
  } catch (error) {
    const rateLimit =
      error instanceof TRPCError ? rateLimitMetadataOf(error.cause) : null;
    const gatewayFailure =
      error instanceof TRPCError
        ? (
            {
              FORBIDDEN: [403, "forbidden"],
              NOT_FOUND: [404, "not-found"],
              PRECONDITION_FAILED: [409, "unavailable"],
            } as const
          )[error.code as "FORBIDDEN" | "NOT_FOUND" | "PRECONDITION_FAILED"]
        : undefined;
    const failure =
      error instanceof SnapshotHttpError
        ? error
        : new SnapshotHttpError(
            rateLimit ? 429 : (gatewayFailure?.[0] ?? 503),
            rateLimit ? "rate-limited" : (gatewayFailure?.[1] ?? "unavailable"),
            rateLimit ?? undefined,
          );
    return Response.json(
      {
        ok: false,
        code: failure.code,
        ...(failure.data.rateLimit
          ? { rateLimit: failure.data.rateLimit }
          : {}),
      },
      {
        status: failure.status,
        headers: {
          ...noStore,
          ...(failure.data.rateLimit
            ? {
                "retry-after": String(
                  Math.ceil(failure.data.rateLimit.retryAfterMs / 1000),
                ),
              }
            : {}),
        },
      },
    );
  } finally {
    if (!streaming) {
      finish();
      timeout.abort();
      void upstream?.body?.cancel().catch(() => undefined);
    }
    void request.body?.cancel().catch(() => undefined);
  }
}
