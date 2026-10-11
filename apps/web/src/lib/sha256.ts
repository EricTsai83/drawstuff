import {
  normalizeToArrayBuffer,
  type ArrayBufferInput,
} from "@/lib/array-buffer";

/** Lowercase hex SHA-256: the content-hash format every upload boundary uses. */
export async function sha256Hex(
  input: ArrayBufferInput | Blob,
): Promise<string> {
  const bytes =
    input instanceof Blob
      ? await input.arrayBuffer()
      : normalizeToArrayBuffer(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
