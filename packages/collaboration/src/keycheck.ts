import type { RoomId } from "./messages.ts";
import { deriveRoomKey, type RoomKey } from "./realtime-crypto.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";
import {
  openEnvelope,
  SEALED_ENVELOPE_OVERHEAD_BYTES,
  sealEnvelope,
  utf8AdditionalData,
  utf8Encoder,
} from "./sealed-envelope.ts";

/**
 * Room key-check value: proof, readable before joining, that the key
 * in a link is the room's key.
 *
 * An empty room has no ciphertext at all, so nothing that already exists can
 * tell a wrong-key link from a right one — which is exactly the room a
 * wrong-key client would poison by writing the first snapshot under its own
 * key. So the room's creator seals a fixed, public plaintext under a derived
 * key and stores the ciphertext on the room row; a joiner that cannot open it
 * holds the wrong key and is refused before the canvas is touched.
 *
 * Storing a known-plaintext ciphertext gives the server nothing it does not
 * already hold: stored snapshots are ciphertext of structured JSON, an equally
 * good verification target, and the room key is 32 random bytes, so neither is
 * brute-forceable. The server cannot verify the value either — verification is
 * decryption, and the key never leaves the browser.
 *
 * Why a transplanted value fails, twice over:
 *
 * - The key is derived with its own purpose (`keycheck`) from the room key,
 *   whose HKDF salt contains the room id and the authorization generation — a
 *   different room or generation derives a different key.
 * - The room id and generation are also bound as authenticated data, so even
 *   under identical key material a moved value fails authentication.
 */

/** Sealed key-check envelope version; bumped only on a breaking change. */
export const KEYCHECK_CRYPTO_VERSION = 1;

/**
 * The sealed plaintext. Fixed and public: AES-GCM's authentication tag is what
 * verifies the key, so the content only needs to be constant.
 */
export const KEYCHECK_PLAINTEXT = "drawstuff-room-key-check";

/**
 * Exact sealed size — the shared sealed-envelope shape
 * (`./sealed-envelope.ts`) around the fixed plaintext. Exact rather than a
 * bound, so the server can refuse anything else at the schema layer without
 * understanding the envelope.
 */
export const KEYCHECK_CIPHERTEXT_BYTES =
  utf8Encoder.encode(KEYCHECK_PLAINTEXT).byteLength +
  SEALED_ENVELOPE_OVERHEAD_BYTES;

/**
 * Authenticated metadata: envelope version, room, generation. Exported so the
 * cross-room / cross-generation binding is a pinned contract rather than a
 * comment.
 */
export function keyCheckAdditionalDataLabel(params: {
  roomId: RoomId;
  authGeneration: number;
}): string {
  return `drawstuff-keycheck/v${KEYCHECK_CRYPTO_VERSION}/${params.roomId}/g${roomAuthGenerationSchema.parse(
    params.authGeneration,
  )}`;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const additionalDataFor = (params: {
  roomId: RoomId;
  authGeneration: number;
}): BufferSource => utf8AdditionalData(keyCheckAdditionalDataLabel(params));

/**
 * Seals the room's key-check value. Base64 in and out of this module: the
 * value only ever travels through tRPC as base64 and is stored server-side as
 * bytes it decodes itself, so no caller needs the raw view.
 */
export async function sealRoomKeyCheck(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
}): Promise<string> {
  const key = await deriveRoomKey({
    roomKey: options.roomKey,
    roomId: options.roomId,
    authGeneration: options.authGeneration,
    purpose: "keycheck",
  });
  const sealed = await sealEnvelope({
    version: KEYCHECK_CRYPTO_VERSION,
    key,
    plaintext: utf8Encoder.encode(KEYCHECK_PLAINTEXT),
    additionalData: additionalDataFor(options),
    randomBytes: options.randomBytes,
  });
  // Sealing a fixed public plaintext under a freshly derived key cannot fail
  // on untrusted input, so a failure here is an environment defect worth
  // surfacing to the caller rather than mapping to a result.
  if (!sealed.ok) throw sealed.failure.cause;
  return toBase64(sealed.ciphertext);
}

/**
 * Verifies a stored key-check value against the key in the link. `false` for
 * every failure — a wrong key, a moved value, tampered bytes and a malformed
 * blob are all the same answer: this link must not join the room. Nothing
 * here throws on untrusted input.
 */
export async function verifyRoomKeyCheck(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
  keyCheckBase64: string;
}): Promise<boolean> {
  let ciphertext: Uint8Array;
  try {
    ciphertext = fromBase64(options.keyCheckBase64);
  } catch {
    return false;
  }
  const key = await deriveRoomKey({
    roomKey: options.roomKey,
    roomId: options.roomId,
    authGeneration: options.authGeneration,
    purpose: "keycheck",
  });
  const opened = await openEnvelope({
    version: KEYCHECK_CRYPTO_VERSION,
    key,
    ciphertext,
    additionalData: additionalDataFor(options),
    // Exact size, expressed as min == max: anything else is not a key check.
    minCiphertextBytes: KEYCHECK_CIPHERTEXT_BYTES,
    maxCiphertextBytes: KEYCHECK_CIPHERTEXT_BYTES,
  });
  return opened.ok;
}
