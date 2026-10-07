import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";

export class SnapshotTransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Actual-byte bound and cancellation apply even to a stalled or dishonest sender. */
export async function readSnapshotBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
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
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum)
        throw new SnapshotTransferError("payload-too-large", 413);
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
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

export async function readAdapterJson<T>(
  response: Response,
  parse: (input: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  try {
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json")
    )
      throw new Error("adapter-delivery-failed");
    const bytes = await readSnapshotBody(
      response.body,
      AUTHORITY_LIMITS.jobBytes,
      signal,
    );
    return parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ) as unknown,
    );
  } catch (error) {
    if (error instanceof SnapshotTransferError)
      throw new Error("adapter-response-too-large");
    throw error;
  } finally {
    await response.body?.cancel();
  }
}
