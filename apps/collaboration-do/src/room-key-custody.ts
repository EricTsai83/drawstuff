import { decodeBase64, encodeBase64 } from "@drawstuff/collaboration/base64";
import {
  roomKeySchema,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";

/**
 * Wrapping for Room's custody copy of a room key (plan 19). Each room and
 * generation gets its own AES-GCM key derived from the Worker secret, and the
 * associated data binds the ciphertext to that room, generation and wrap
 * version, so a wrapped key cannot be replayed into another room or
 * generation. Anyone holding `COLLAB_ROOM_KEY_WRAP_SECRET` and this storage can
 * unwrap every custodied key; that is the accepted cost of custody.
 */
const ROOM_KEY_WRAP_VERSION = 1;
const IV_BYTES = 12;
/** iv + AES-GCM ciphertext of a 43-character base64url key + 16-byte tag. */
const MAX_WRAPPED_BYTES = 128;
const encoder = new TextEncoder();

export function keyWrapSecretReady(secret: string | undefined): boolean {
  return typeof secret === "string" && secret.length >= 32;
}

async function wrappingKey(options: {
  secret: string;
  roomId: string;
  authGeneration: number;
  wrapVersion: number;
}): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`drawstuff-room-key-wrap/v${options.wrapVersion}`),
      info: encoder.encode(`${options.roomId}/g${options.authGeneration}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const additionalData = (options: {
  roomId: string;
  authGeneration: number;
  wrapVersion: number;
}) =>
  encoder.encode(
    `drawstuff-room-key/${options.roomId}/g${options.authGeneration}/v${options.wrapVersion}`,
  );

export async function wrapRoomKey(options: {
  secret: string;
  roomId: string;
  authGeneration: number;
  roomKey: RoomKey;
}): Promise<{ wrapped: string; wrapVersion: number }> {
  const params = { ...options, wrapVersion: ROOM_KEY_WRAP_VERSION };
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(params) },
      await wrappingKey(params),
      encoder.encode(options.roomKey),
    ),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv);
  out.set(ciphertext, IV_BYTES);
  return { wrapped: encodeBase64(out), wrapVersion: ROOM_KEY_WRAP_VERSION };
}

/** Throws on any mismatch: a wrapped key that does not open is never released. */
export async function unwrapRoomKey(options: {
  secret: string;
  roomId: string;
  authGeneration: number;
  wrapped: string;
  wrapVersion: number;
}): Promise<RoomKey> {
  const decoded = decodeBase64(options.wrapped, {
    maxBytes: MAX_WRAPPED_BYTES,
  });
  if (!decoded.ok || decoded.bytes.byteLength <= IV_BYTES)
    throw new Error("invalid-wrapped-key");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decoded.bytes.slice(0, IV_BYTES),
      additionalData: additionalData(options),
    },
    await wrappingKey(options),
    decoded.bytes.slice(IV_BYTES),
  );
  return roomKeySchema.parse(new TextDecoder().decode(plaintext));
}
