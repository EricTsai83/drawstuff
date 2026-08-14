/**
 * Internal sealed-envelope primitive shared by every sealed format in this
 * package: realtime frames (`./realtime-crypto.ts`), durable snapshots
 * (`./snapshot.ts`), stored assets (`./asset-crypto.ts`) and the room
 * key-check value (`./keycheck.ts`).
 *
 * All four formats use the same layout on purpose — fixed size, no variable
 * fields, no sender identity:
 *
 * ```
 * 0                  envelope version
 * 1 .. 13            random IV
 * rest               AES-GCM ciphertext ‖ tag
 * ```
 *
 * What stays *outside* this module is exactly what keeps the formats
 * independent: each format owns its version constant, its AAD label, its
 * size bounds and its public error union, so bumping one envelope version or
 * changing one bound never touches the others. This module owns only the
 * byte layout and the seal/open mechanics, which is the part that had been
 * copy-adapted four times and had already drifted (the realtime copy was
 * missing the max-size bound the other two enforced).
 *
 * Not a public entry point: consumers use the four format modules.
 */

const SEALED_ENVELOPE_VERSION_BYTES = 1;

/** AES-GCM standard nonce length; the only length with a hardware-fast path. */
export const SEALED_ENVELOPE_IV_BYTES = 12;

/** AES-GCM authentication tag length appended to every ciphertext. */
export const SEALED_ENVELOPE_TAG_BYTES = 16;

export const SEALED_ENVELOPE_HEADER_BYTES =
  SEALED_ENVELOPE_VERSION_BYTES + SEALED_ENVELOPE_IV_BYTES;

/** Bytes a sealed envelope adds to its plaintext: header plus GCM tag. */
export const SEALED_ENVELOPE_OVERHEAD_BYTES =
  SEALED_ENVELOPE_HEADER_BYTES + SEALED_ENVELOPE_TAG_BYTES;

/** Shared UTF-8 encoder for AAD labels, KDF inputs, and digests. */
export const utf8Encoder = new TextEncoder();

/**
 * Web Crypto's `BufferSource` excludes `SharedArrayBuffer`-backed views, which
 * TypeScript cannot prove for a plain `Uint8Array`. Every view handed to Web
 * Crypto in this package comes from `new Uint8Array`, `TextEncoder`, a
 * WebSocket frame, or a `fetch` response body, never from shared memory, so
 * the narrowing is sound — and it stays in this single place rather than
 * spreading `Uint8Array<ArrayBuffer>` through the protocol codec's public
 * types.
 */
export const asBufferSource = (view: Uint8Array): BufferSource =>
  view as BufferSource;

const HEX_BY_BYTE = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

export const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) hex += HEX_BY_BYTE[byte];
  return hex;
};

/** Encodes a format's authenticated-data label. */
export const utf8AdditionalData = (label: string): BufferSource =>
  asBufferSource(utf8Encoder.encode(label));

export const defaultRandomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

type SealEnvelopeFailure = {
  code: "encrypt-failed";
  /** The error name, never the key or the plaintext: a caller may log this. */
  errorName: string;
  /** The original throw, for the one format that propagates it (keycheck). */
  cause: unknown;
};

export type SealEnvelopeResult =
  | { ok: true; ciphertext: Uint8Array }
  | { ok: false; failure: SealEnvelopeFailure };

export async function sealEnvelope(options: {
  /** The format's own envelope version; written as the first byte. */
  version: number;
  key: CryptoKey;
  plaintext: Uint8Array;
  additionalData: BufferSource;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
}): Promise<SealEnvelopeResult> {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const iv = randomBytes(SEALED_ENVELOPE_IV_BYTES);
  if (iv.byteLength !== SEALED_ENVELOPE_IV_BYTES) {
    throw new Error(
      `randomBytes must return ${SEALED_ENVELOPE_IV_BYTES} bytes, received ${iv.byteLength}`,
    );
  }
  let sealed: ArrayBuffer;
  try {
    sealed = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(iv),
        additionalData: options.additionalData,
      },
      options.key,
      asBufferSource(options.plaintext),
    );
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "encrypt-failed",
        errorName: error instanceof Error ? error.name : "Encryption failed",
        cause: error,
      },
    };
  }
  const ciphertext = new Uint8Array(
    SEALED_ENVELOPE_HEADER_BYTES + sealed.byteLength,
  );
  ciphertext[0] = options.version;
  ciphertext.set(iv, SEALED_ENVELOPE_VERSION_BYTES);
  ciphertext.set(new Uint8Array(sealed), SEALED_ENVELOPE_HEADER_BYTES);
  return { ok: true, ciphertext };
}

type OpenEnvelopeFailure =
  | {
      code: "below-min-size";
      receivedByteLength: number;
      minByteLength: number;
    }
  | {
      code: "above-max-size";
      receivedByteLength: number;
      maxByteLength: number;
    }
  | { code: "unknown-version"; receivedVersion: number | undefined }
  /** Wrong key, tampered ciphertext/IV, or mismatched authenticated data. */
  | { code: "authentication-failed" };

export type OpenEnvelopeResult =
  | { ok: true; plaintext: Uint8Array; iv: Uint8Array }
  | { ok: false; failure: OpenEnvelopeFailure };

export async function openEnvelope(options: {
  version: number;
  key: CryptoKey;
  ciphertext: Uint8Array;
  additionalData: BufferSource;
  minCiphertextBytes: number;
  /**
   * Mandatory: an envelope accepted sight unseen needs a stated ceiling, or
   * whatever transport/storage cap happens to sit in front of it becomes an
   * implicit cross-module dependency.
   */
  maxCiphertextBytes: number;
}): Promise<OpenEnvelopeResult> {
  const { ciphertext } = options;
  if (ciphertext.byteLength < options.minCiphertextBytes) {
    return {
      ok: false,
      failure: {
        code: "below-min-size",
        receivedByteLength: ciphertext.byteLength,
        minByteLength: options.minCiphertextBytes,
      },
    };
  }
  if (ciphertext.byteLength > options.maxCiphertextBytes) {
    return {
      ok: false,
      failure: {
        code: "above-max-size",
        receivedByteLength: ciphertext.byteLength,
        maxByteLength: options.maxCiphertextBytes,
      },
    };
  }
  const receivedVersion = ciphertext[0];
  if (receivedVersion !== options.version) {
    return {
      ok: false,
      failure: { code: "unknown-version", receivedVersion },
    };
  }
  const iv = ciphertext.subarray(
    SEALED_ENVELOPE_VERSION_BYTES,
    SEALED_ENVELOPE_HEADER_BYTES,
  );
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(iv),
        additionalData: options.additionalData,
      },
      options.key,
      asBufferSource(ciphertext.subarray(SEALED_ENVELOPE_HEADER_BYTES)),
    );
    return { ok: true, plaintext: new Uint8Array(opened), iv };
  } catch {
    // A wrong key, a flipped ciphertext bit, an altered IV and mismatched
    // authenticated data are all the same answer: this envelope is not from
    // an authorized sealer.
    return { ok: false, failure: { code: "authentication-failed" } };
  }
}
