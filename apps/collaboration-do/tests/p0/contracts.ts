import { z } from "zod";
import { MAX_SNAPSHOT_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/snapshot";

// Test-only prototype. Production integration remains 18B P1/P2.
export const MAX_BINARY_BYTES = MAX_SNAPSHOT_CIPHERTEXT_BYTES;
export const OPERATION_TTL_MS = 60_000;
export const NORMAL_QUEUE_LIMIT = 128;
export const SECURITY_QUEUE_LIMIT = 64;
export const MANAGEMENT_RESULT_LIMIT = 4_096;
export const RESULT_RETENTION_MS = 24 * 60 * 60_000;
export const INITIALIZATION_TTL_MS = 15 * 60_000;
export const BODY_CONCURRENCY_LIMIT = 2;
export const ALARM_BATCH_LIMIT = 16;
export const ALARM_BUDGET_MS = 5_000;
export const EXTERNAL_TIMEOUT_MS = 15_000;
export const operationSchema = z.strictObject({
  roomId: z.string().min(1).max(100),
  operationId: z.string().uuid(),
  actor: z.enum(["owner", "writer"]),
  epoch: z.int().positive(),
  authGeneration: z.literal(1),
  expectedRevision: z.int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  deadline: z.int().positive(),
  subject: z.string().min(1).max(100).optional(),
  assetIds: z.array(z.string().uuid()).max(16).optional(),
});
export type Operation = z.infer<typeof operationSchema>;
export const resultSchema = z.strictObject({
  status: z.enum(["written", "cancelled", "refused", "conflict", "pending"]),
  revision: z.int().nonnegative().nullable(),
});
export type OperationResult = z.infer<typeof resultSchema>;

export async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error("empty-body");
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array))
        throw new Error("invalid-body-chunk");
      length += chunk.value.byteLength;
      if (length > MAX_BINARY_BYTES) throw new Error("body-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  if (length === 0) throw new Error("empty-body");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function checksum(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
