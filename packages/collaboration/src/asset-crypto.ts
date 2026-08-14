import { excalidrawFileIdSchema } from "./asset-identity.ts";
import { MAX_ASSET_PLAINTEXT_BYTES } from "./asset-payload.ts";
import type { RoomId } from "./messages.ts";
import { deriveRoomKey, type RoomKey } from "./realtime-crypto.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";
import {
  defaultRandomBytes,
  openEnvelope,
  SEALED_ENVELOPE_HEADER_BYTES,
  SEALED_ENVELOPE_OVERHEAD_BYTES,
  sealEnvelope,
  utf8AdditionalData,
} from "./sealed-envelope.ts";

/**
 * Sealed envelope for one collaboration asset — what storage holds.
 *
 * The envelope is a version byte, a random IV and AES-GCM ciphertext under a
 * key derived from the room key with purpose `asset`. The app backend and the
 * object store therefore hold bytes neither can read, and neither ever sees
 * the room key. Versioned independently of the realtime frame format and the
 * payload framing (`./asset-payload.ts`) because it is sealed under its own
 * derived key and evolves on its own schedule.
 */

/**
 * Sealed asset envelope version. Independent from `REALTIME_CRYPTO_VERSION` and
 * `SNAPSHOT_CRYPTO_VERSION`: the three formats are sealed under different derived
 * keys and evolve separately, so sharing a version number would couple them for
 * no reason.
 */
export const ASSET_CRYPTO_VERSION = 1;

/**
 * Sealed asset layout — the shared sealed-envelope shape
 * (`./sealed-envelope.ts`), same as a realtime frame and a sealed snapshot,
 * and for the same reason: fixed size, no variable fields, no sender identity.
 */
export const ASSET_SEALED_HEADER_BYTES = SEALED_ENVELOPE_HEADER_BYTES;

export const ASSET_SEALED_OVERHEAD_BYTES = SEALED_ENVELOPE_OVERHEAD_BYTES;

/** Smallest byte length that could still be a sealed asset. */
export const MIN_ASSET_CIPHERTEXT_BYTES = ASSET_SEALED_OVERHEAD_BYTES + 1;

/** Wire/storage ceiling: the plaintext budget plus sealing overhead. */
export const MAX_ASSET_CIPHERTEXT_BYTES =
  MAX_ASSET_PLAINTEXT_BYTES + ASSET_SEALED_OVERHEAD_BYTES;

/**
 * Derives the room's asset key. Separate purpose from realtime traffic and from
 * durable snapshots, so a leaked realtime or snapshot key cannot open stored
 * assets, and bound to the authorization generation, so rotating the generation
 * makes every asset sealed under the previous one unreadable.
 */
export function deriveAssetKey(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
}): Promise<CryptoKey> {
  return deriveRoomKey({ ...options, purpose: "asset" });
}

export type AssetCryptoError =
  | { code: "malformed-sealed-asset"; detail: string }
  | { code: "unknown-crypto-version"; receivedVersion: number | undefined }
  /** Wrong key, rotated generation, tampered bytes, or a mismatched file id. */
  | { code: "authentication-failed" };

export type SealAssetResult =
  { ok: true; ciphertext: Uint8Array } | { ok: false; error: AssetCryptoError };

export type OpenAssetResult =
  { ok: true; plaintext: Uint8Array } | { ok: false; error: AssetCryptoError };

/**
 * Versioned asset codec: one instance per room generation, holding the single
 * derived key. Deliberately separate from the realtime codec — that one counts
 * messages against an IV-collision budget for a long-lived stream of small
 * frames, while this one seals a handful of large, independently stored objects
 * and has no stream to bound.
 */
export interface AssetCryptoCodec {
  readonly cryptoVersion: typeof ASSET_CRYPTO_VERSION;
  seal(input: {
    excalidrawFileId: string;
    plaintext: Uint8Array;
  }): Promise<SealAssetResult>;
  open(input: {
    excalidrawFileId: string;
    ciphertext: Uint8Array;
  }): Promise<OpenAssetResult>;
}

/**
 * Authenticated metadata. Everything a storage layer can see is bound to the
 * ciphertext: envelope version, room, authorization generation and the asset's
 * own file id. Binding the file id is what makes serving asset A's bytes under
 * asset B's record a decryption failure rather than a rendered image in the
 * wrong place.
 *
 * Deliberately free of `COLLABORATION_PROTOCOL_VERSION`: that versions
 * transport messages, and a stored asset is durable state. It used to be bound
 * here as well, which made every stored asset unreadable after a purely
 * transport-side protocol bump; the asset's own envelope version is the only
 * format version that belongs in this seal.
 *
 * Exported so the "no transport version reaches durable authenticated data"
 * property is a pinned contract rather than a comment.
 */
export function assetAdditionalDataLabel(params: {
  roomId: RoomId;
  authGeneration: number;
  excalidrawFileId: string;
}): string {
  return `drawstuff-asset/v${ASSET_CRYPTO_VERSION}/${params.roomId}/g${roomAuthGenerationSchema.parse(
    params.authGeneration,
  )}/${excalidrawFileIdSchema.parse(params.excalidrawFileId)}`;
}

const assetAdditionalData = (params: {
  roomId: RoomId;
  authGeneration: number;
  excalidrawFileId: string;
}): BufferSource => utf8AdditionalData(assetAdditionalDataLabel(params));

export async function createAssetCryptoCodec(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
}): Promise<AssetCryptoCodec> {
  const { roomId, authGeneration, randomBytes = defaultRandomBytes } = options;
  // Derived once per session: the key is bound to (room, generation, purpose),
  // and it is non-extractable, so it cannot end up in a log or an error payload.
  const key = await deriveAssetKey({
    roomKey: options.roomKey,
    roomId,
    authGeneration,
  });

  return {
    cryptoVersion: ASSET_CRYPTO_VERSION,

    async seal({ excalidrawFileId, plaintext }) {
      if (plaintext.byteLength > MAX_ASSET_PLAINTEXT_BYTES) {
        return {
          ok: false,
          error: {
            code: "malformed-sealed-asset",
            detail: `Asset plaintext must be at most ${MAX_ASSET_PLAINTEXT_BYTES} bytes, received ${plaintext.byteLength}`,
          },
        };
      }
      const sealed = await sealEnvelope({
        version: ASSET_CRYPTO_VERSION,
        key,
        plaintext,
        additionalData: assetAdditionalData({
          roomId,
          authGeneration,
          excalidrawFileId,
        }),
        randomBytes,
      });
      if (!sealed.ok) {
        // The error name, never the key or the plaintext: a caller may log this.
        return {
          ok: false,
          error: {
            code: "malformed-sealed-asset",
            detail: sealed.failure.errorName,
          },
        };
      }
      return { ok: true, ciphertext: sealed.ciphertext };
    },

    async open({ excalidrawFileId, ciphertext }) {
      const opened = await openEnvelope({
        version: ASSET_CRYPTO_VERSION,
        key,
        ciphertext,
        additionalData: assetAdditionalData({
          roomId,
          authGeneration,
          excalidrawFileId,
        }),
        minCiphertextBytes: MIN_ASSET_CIPHERTEXT_BYTES,
        maxCiphertextBytes: MAX_ASSET_CIPHERTEXT_BYTES,
      });
      if (opened.ok) return { ok: true, plaintext: opened.plaintext };
      const { failure } = opened;
      switch (failure.code) {
        case "below-min-size":
        case "above-max-size":
          return {
            ok: false,
            error: {
              code: "malformed-sealed-asset",
              detail: `Sealed asset must be ${MIN_ASSET_CIPHERTEXT_BYTES}..${MAX_ASSET_CIPHERTEXT_BYTES} bytes, received ${failure.receivedByteLength}`,
            },
          };
        case "unknown-version":
          return {
            ok: false,
            error: {
              code: "unknown-crypto-version",
              receivedVersion: failure.receivedVersion,
            },
          };
        case "authentication-failed":
          // A wrong key, a rotated generation, tampered bytes and a file id
          // that does not match the seal are all the same answer: these are
          // not bytes this reader can trust.
          return { ok: false, error: { code: "authentication-failed" } };
      }
    },
  };
}
