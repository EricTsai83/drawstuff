import { z } from "zod";
import {
  ADAPTER_METADATA_MAX_BYTES,
  AUTHORITY_LIMITS,
  SNAPSHOT_RECEIPT_HEADER,
  SNAPSHOT_REQUEST_HEADER,
  authorityErrorSchema,
  contentResultSchema,
  snapshotAbsenceReceiptSchema,
  snapshotReceiptSchema,
  snapshotRequestSchema,
} from "@drawstuff/collaboration/authority";
import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
  SNAPSHOT_CRYPTO_VERSION,
  snapshotCiphertextChecksum,
} from "@drawstuff/collaboration/snapshot";
import { withCollaborationRequestDeadline } from "./request-deadline";

const SNAPSHOT_HTTP_PATH = "/api/collaboration/snapshot";
export const SNAPSHOT_INTENT_HEADER = "x-drawstuff-snapshot-intent";
type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;
type SnapshotOperation = Exclude<
  SnapshotRequest,
  { action: "read" }
>["operation"];
type SnapshotRead = Extract<SnapshotRequest, { action: "read" }>;

export const snapshotHttpErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.union([
    authorityErrorSchema,
    z.enum([
      "malformed",
      "unauthorized",
      "unavailable",
      "payload-too-large",
      "invalid-body",
      "rate-limited",
    ]),
  ]),
  rateLimit: z
    .strictObject({
      reset: z.number().finite(),
      retryAfterMs: z.number().nonnegative(),
    })
    .optional(),
});

export class SnapshotHttpError extends Error {
  readonly data: { rateLimit?: { reset: number; retryAfterMs: number } };
  constructor(
    readonly status: number,
    readonly code: z.infer<typeof snapshotHttpErrorSchema>["code"],
    rateLimit?: { reset: number; retryAfterMs: number },
  ) {
    super(
      "Snapshot request was not confirmed. Query or retry the same operation.",
    );
    this.name = "SnapshotHttpError";
    this.data = rateLimit ? { rateLimit } : {};
  }
}

/** Abort even if an injected transport or stalled body ignores the signal. */
export async function waitForSnapshot<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("snapshot-aborted"),
          );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function readSnapshotHttpBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await waitForSnapshot(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum)
        throw new SnapshotHttpError(413, "payload-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readSnapshotHttpJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    void response.body?.cancel().catch(() => undefined);
    throw new SnapshotHttpError(503, "unavailable");
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readSnapshotHttpBody(
          response.body,
          AUTHORITY_LIMITS.jobBytes,
          signal,
        ),
      ),
    ) as unknown;
  } catch {
    // Bad upstream replies are service failures, not upload-size refusals.
    throw new SnapshotHttpError(503, "unavailable");
  }
}

export function parseSnapshotHttpReceipt(response: Response, roomId: string) {
  const header = response.headers.get(SNAPSHOT_RECEIPT_HEADER);
  if (
    !header ||
    new TextEncoder().encode(header).byteLength > ADAPTER_METADATA_MAX_BYTES
  )
    throw new SnapshotHttpError(503, "unavailable");
  const input = JSON.parse(header) as unknown;
  if (response.status === 404) {
    const receipt = snapshotAbsenceReceiptSchema.parse(input);
    if (receipt.roomId !== roomId)
      throw new SnapshotHttpError(503, "unavailable");
    return { found: false as const, receipt };
  }
  const receipt = snapshotReceiptSchema.parse(input);
  if (
    response.status !== 200 ||
    receipt.roomId !== roomId ||
    receipt.byteLength < MIN_SNAPSHOT_SEALED_BYTES ||
    receipt.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES ||
    response.headers.get("content-type") !== "application/octet-stream"
  )
    throw new SnapshotHttpError(503, "unavailable");
  return { found: true as const, receipt };
}

/** Transport only: callers retain the original operation and sealed bytes across retries. */
export function createBinarySnapshotClient(fetchImpl: typeof fetch = fetch) {
  async function send(
    request: SnapshotRequest,
    bytes: Uint8Array,
    intent: "cadence" | "leave",
    signal: AbortSignal,
  ) {
    const metadata = JSON.stringify(snapshotRequestSchema.parse(request));
    if (
      new TextEncoder().encode(metadata).byteLength > ADAPTER_METADATA_MAX_BYTES
    )
      throw new SnapshotHttpError(400, "malformed");
    const put =
      request.action === "write" && request.operation.kind === "snapshot-put";
    if (bytes.byteLength > (put ? MAX_SNAPSHOT_CIPHERTEXT_BYTES : 0))
      throw new SnapshotHttpError(413, "payload-too-large");
    return waitForSnapshot(
      fetchImpl(SNAPSHOT_HTTP_PATH, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: {
          "content-type": "application/octet-stream",
          [SNAPSHOT_REQUEST_HEADER]: metadata,
          [SNAPSHOT_INTENT_HEADER]: intent,
        },
        body: bytes.slice().buffer,
        signal,
      }),
      signal,
    );
  }
  async function failure(
    response: Response,
    signal: AbortSignal,
  ): Promise<never> {
    const error = snapshotHttpErrorSchema.parse(
      await readSnapshotHttpJson(response, signal),
    );
    throw new SnapshotHttpError(
      response.status,
      error.code,
      response.status === 429 ? error.rateLimit : undefined,
    );
  }
  async function control(
    request: Exclude<SnapshotRequest, SnapshotRead>,
    bytes: Uint8Array,
    intent: "cadence" | "leave",
    parentSignal?: AbortSignal,
  ) {
    return withCollaborationRequestDeadline(async (signal) => {
      const response = await send(request, bytes, intent, signal);
      if (response.status !== 200) return failure(response, signal);
      const result = contentResultSchema.parse(
        await readSnapshotHttpJson(response, signal),
      );
      if (
        result.status === "written" &&
        result.revision !== request.operation.expectedRevision + 1
      )
        throw new SnapshotHttpError(503, "unavailable");
      return result;
    }, parentSignal);
  }
  return {
    read(request: SnapshotRead, parentSignal?: AbortSignal) {
      return withCollaborationRequestDeadline(async (signal) => {
        const response = await send(
          request,
          new Uint8Array(),
          "cadence",
          signal,
        );
        try {
          if (
            response.status !== 200 &&
            !(
              response.status === 404 &&
              response.headers.has(SNAPSHOT_RECEIPT_HEADER)
            )
          )
            return await failure(response, signal);
          const result = parseSnapshotHttpReceipt(response, request.roomId);
          if (!result.found) {
            const error = snapshotHttpErrorSchema.parse(
              await readSnapshotHttpJson(response, signal),
            );
            if (error.code !== "not-found")
              throw new SnapshotHttpError(503, "unavailable");
            return { ...result, bytes: null };
          }
          const bytes = await readSnapshotHttpBody(
            response.body,
            result.receipt.byteLength,
            signal,
          );
          if (
            bytes.byteLength !== result.receipt.byteLength ||
            bytes[0] !== SNAPSHOT_CRYPTO_VERSION ||
            (await snapshotCiphertextChecksum(bytes)) !==
              result.receipt.checksum
          )
            throw new SnapshotHttpError(503, "unavailable");
          return { ...result, bytes };
        } finally {
          void response.body?.cancel().catch(() => undefined);
        }
      }, parentSignal);
    },
    write(
      operation: SnapshotOperation,
      bytes: Uint8Array,
      intent: "cadence" | "leave" = "cadence",
      signal?: AbortSignal,
    ) {
      return control({ action: "write", operation }, bytes, intent, signal);
    },
    query(operation: SnapshotOperation, signal?: AbortSignal) {
      return control(
        { action: "query", operation },
        new Uint8Array(),
        "cadence",
        signal,
      );
    },
    cancel(operation: SnapshotOperation, signal?: AbortSignal) {
      return control(
        { action: "cancel", operation },
        new Uint8Array(),
        "cadence",
        signal,
      );
    },
  };
}
