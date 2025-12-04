export type Uint8ArrayLike = Uint8Array<ArrayBufferLike>;

export type ArrayBufferInput = ArrayBuffer | Uint8ArrayLike;

/**
 * 確保輸入資料為 ArrayBuffer，避免 SharedArrayBuffer 造成型別不相容。
 */
export function normalizeToArrayBuffer(input: ArrayBufferInput): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }

  const coversWholeBuffer =
    input.byteOffset === 0 && input.byteLength === input.buffer.byteLength;

  if (coversWholeBuffer && input.buffer instanceof ArrayBuffer) {
    return input.buffer;
  }

  const bufferCopy = new ArrayBuffer(input.byteLength);
  new Uint8Array(bufferCopy).set(input);
  return bufferCopy;
}
