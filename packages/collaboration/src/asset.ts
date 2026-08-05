import { z } from "zod";

import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
  type RoomId,
} from "./messages.ts";
import {
  AES_GCM_TAG_BYTES,
  deriveRoomKey,
  REALTIME_NONCE_BYTES,
  type RoomKey,
} from "./realtime-crypto.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";

/**
 * Collaboration assets: identity (Plan 16) and encrypted transfer (Plan 17).
 *
 * An asset is a binary file an image element points at. Its identity is the
 * pair *parent scope + Excalidraw file id*, and nothing else:
 *
 * - The **Excalidraw file id** is produced by the canvas engine
 *   (`generateIdFromFile`) as the SHA-1 of the file's bytes, falls back to
 *   `nanoid(40)` only when the digest itself fails, and is written into
 *   `element.fileId`. It is immutable and it is the only value a peer can use
 *   to say "the image this element renders".
 * - The **parent scope** is the room generation (here) or the scene
 *   (`file_record`), which is what keeps one room's assets from resolving
 *   inside another.
 *
 * Three things are deliberately *not* identity:
 *
 * - **A filename.** Two different images can share one; the same image can
 *   arrive under several. It carries no guarantee at all.
 * - **A content hash of the stored payload.** Storage payloads are compressed
 *   and sealed with per-write metadata, so the same image hashes differently
 *   every time it is stored — treating that as identity silently duplicates
 *   assets instead of deduplicating them.
 * - **A storage object key or URL.** Those identify where bytes happen to live
 *   now, not which image an element references; re-uploading the same image
 *   yields a new key.
 *
 * Plan 17 adds the bytes. Two formats live here, both versioned independently
 * of the realtime frame format because they are sealed under a different derived
 * key and evolve on their own schedule:
 *
 * - The **payload** is the plaintext an asset consists of: the engine's data URL
 *   plus the metadata needed to hand it back to the engine (`mimeType`) and to
 *   cross-check it against the record it was fetched under (`roomId`, `fileId`).
 * - The **sealed envelope** is what storage holds: a version byte, a random IV
 *   and AES-GCM ciphertext under a key derived from the room key with purpose
 *   `asset`. The app backend and the object store therefore hold bytes neither
 *   can read, and neither ever sees the room key.
 *
 * The realtime channel never carries asset bytes: `syncedElementSchema` refuses
 * embedded binary data (`FORBIDDEN_BINARY_ELEMENT_KEYS`), so what travels is the
 * file id on the element, and availability is answered by the room's asset
 * records.
 */

/**
 * Same character set and bound as the room/client/peer ids in `messages.ts`,
 * but for a different reason: this one has to accept whatever the *engine*
 * generates. SHA-1 hex and `nanoid(40)` both fit, and a stricter hex-only check
 * would reject a legitimate fallback id.
 */
export const EXCALIDRAW_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const excalidrawFileIdSchema = z
  .string()
  .regex(EXCALIDRAW_FILE_ID_PATTERN);
export type ExcalidrawAssetId = z.infer<typeof excalidrawFileIdSchema>;

/**
 * Ceiling on how many distinct assets one room generation may claim. The room's
 * asset set is written by authorized members, so it needs a bound for the same
 * reason a snapshot's byte length does: an authorized member must not be able to
 * grow the database — or the object store — without limit. Well above what a
 * real scene references, and low enough that the whole set is one small round
 * trip.
 */
export const MAX_ROOM_ASSETS_PER_GENERATION = 512;

/**
 * Ceiling per lookup call. A client asks for the assets the elements it just
 * received reference, so this bounds one request without bounding how many
 * assets a room can accumulate.
 */
export const MAX_ASSET_LOOKUP_BATCH = 64;

/**
 * MIME types a room asset may declare.
 *
 * The engine's own image set (upstream `IMAGE_MIME_TYPES`), and nothing else:
 * `BinaryFileData.mimeType` also admits `application/octet-stream`, but a room
 * asset is an image an element renders, and arbitrary file sharing is explicitly
 * out of scope. Validated on both sides of the transfer — the sealing client
 * refuses to encode an unsupported type, and the receiving client refuses to
 * decode one — so a peer cannot use the asset channel to hand another peer an
 * arbitrary payload to render.
 */
export const COLLABORATION_ASSET_MIME_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
] as const;

export const collaborationAssetMimeTypeSchema = z.enum(
  COLLABORATION_ASSET_MIME_TYPES,
);
export type CollaborationAssetMimeType = z.infer<
  typeof collaborationAssetMimeTypeSchema
>;

/** Asset payload version; bumped only on a breaking plaintext layout change. */
export const ASSET_PAYLOAD_VERSION = 1;

/**
 * Sealed asset envelope version. Independent from `REALTIME_CRYPTO_VERSION` and
 * `SNAPSHOT_CRYPTO_VERSION`: the three formats are sealed under different derived
 * keys and evolve separately, so sharing a version number would couple them for
 * no reason.
 */
export const ASSET_CRYPTO_VERSION = 1;

const VERSION_BYTES = 1;
const METADATA_LENGTH_BYTES = 2;

/**
 * Plaintext layout — a fixed header, a bounded JSON metadata chunk, then the
 * data URL bytes verbatim:
 *
 * ```
 * 0                  payload version
 * 1 .. 2             metadata byte length (uint16, big endian)
 * 3 .. 3+n           metadata JSON (UTF-8)
 * rest               data URL bytes (UTF-8)
 * ```
 *
 * The data URL is *not* wrapped in JSON, which is the whole reason for the
 * framing. A data URL is already base64 and is the largest thing here by three
 * orders of magnitude; `JSON.stringify` would copy it into a second multi-megabyte
 * string and `JSON.parse` a third, for no gain — nothing in it needs escaping.
 * The metadata is small, fixed-shape and worth validating, so it stays JSON.
 */
export const ASSET_PAYLOAD_HEADER_BYTES = VERSION_BYTES + METADATA_LENGTH_BYTES;

/** Metadata chunk ceiling; the fields are all short and bounded by schema. */
export const MAX_ASSET_METADATA_BYTES = 512;

/**
 * Data URL ceiling for one asset.
 *
 * A data URL is base64, so this admits an image of about three quarters of it —
 * comfortably above the engine's own `MAX_ALLOWED_FILE_BYTES` image limit, and
 * the same order as the owned-scene upload bound (`FILE_UPLOAD_MAX_BYTES`). It is
 * enforced before any encode or decode work: an oversize payload is refused, not
 * truncated.
 */
export const MAX_ASSET_DATA_URL_BYTES = 3 * 1_048_576;

export const MAX_ASSET_PLAINTEXT_BYTES =
  ASSET_PAYLOAD_HEADER_BYTES +
  MAX_ASSET_METADATA_BYTES +
  MAX_ASSET_DATA_URL_BYTES;

/**
 * Sealed asset layout — same shape as a realtime frame and a sealed snapshot,
 * and for the same reason: fixed size, no variable fields, no sender identity.
 *
 * ```
 * 0                  envelope version
 * 1 .. 13            random IV
 * rest               AES-GCM ciphertext ‖ tag
 * ```
 */
export const ASSET_SEALED_HEADER_BYTES = VERSION_BYTES + REALTIME_NONCE_BYTES;

export const ASSET_SEALED_OVERHEAD_BYTES =
  ASSET_SEALED_HEADER_BYTES + AES_GCM_TAG_BYTES;

/** Smallest byte length that could still be a sealed asset. */
export const MIN_ASSET_CIPHERTEXT_BYTES = ASSET_SEALED_OVERHEAD_BYTES + 1;

/** Wire/storage ceiling: the plaintext budget plus sealing overhead. */
export const MAX_ASSET_CIPHERTEXT_BYTES =
  MAX_ASSET_PLAINTEXT_BYTES + ASSET_SEALED_OVERHEAD_BYTES;

/**
 * Longest asset URL the transfer contract admits, and the same bound the storage
 * column carries. Kept in step deliberately: a longer URL is one the store could
 * never have persisted, so refusing it at the boundary is more honest than
 * accepting a record no writer could produce.
 */
export const MAX_ASSET_URL_LENGTH = 512;

/**
 * What a client learns about one available asset. `url` is where the ciphertext
 * currently lives, which is deliberately not identity: it changes on re-upload
 * and it is only ever resolved *from* the identity pair.
 */
export const collaborationAssetRecordSchema = z.strictObject({
  excalidrawFileId: excalidrawFileIdSchema,
  cryptoVersion: z.int().positive(),
  byteLength: z.int().positive().max(MAX_ASSET_CIPHERTEXT_BYTES),
  /**
   * HTTPS only. The ciphertext is unreadable without the room key, so the
   * transport does not protect confidentiality — but it does protect the URL
   * itself, which is the capability that locates the bytes, and a plain-HTTP
   * fetch would leak it to the network and break under mixed-content rules.
   */
  url: z
    .string()
    .url()
    .max(MAX_ASSET_URL_LENGTH)
    .refine((value) => value.startsWith("https://"), {
      message: "Asset URL must be https",
    }),
});
export type CollaborationAssetRecord = z.infer<
  typeof collaborationAssetRecordSchema
>;

/**
 * Answer to "where are the bytes for these file ids".
 *
 * `authGeneration` is part of the answer rather than an input echo: a client
 * that rotated generations mid-flight can tell that the records it just read
 * belong to the generation its asset key is derived for, instead of trying to
 * open ciphertext sealed under a key it no longer has.
 *
 * `missing` is a first-class outcome, not an error. A peer broadcasts an image
 * element the moment it is added and the ciphertext lands a beat later, so "not
 * yet" is the normal state for a fresh image and the caller's job is to retry —
 * whereas an asset the room never had is one it must stop asking for.
 */
export const collaborationAssetLookupSchema = z.strictObject({
  roomId: roomIdSchema,
  authGeneration: roomAuthGenerationSchema,
  assets: z
    .array(collaborationAssetRecordSchema)
    .max(MAX_ROOM_ASSETS_PER_GENERATION),
  missing: z.array(excalidrawFileIdSchema).max(MAX_ASSET_LOOKUP_BATCH),
});
export type CollaborationAssetLookup = z.infer<
  typeof collaborationAssetLookupSchema
>;

/**
 * Canonicalizes a batch of requested ids: deduplicated and sorted.
 *
 * A batch that names the same asset twice is not an error — but it must not
 * consume two slots of the room's budget or produce two conflicting inserts, and
 * a stable order keeps a retried request from touching rows in a different
 * sequence than the attempt it repeats.
 */
export function canonicalizeAssetIds(
  fileIds: readonly string[],
): ExcalidrawAssetId[] {
  return [...new Set(fileIds)].sort();
}

const encoder = new TextEncoder();
// Fatal so malformed UTF-8 is refused rather than repaired into a different
// (possibly valid) payload via U+FFFD replacement.
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Web Crypto's `BufferSource` excludes `SharedArrayBuffer`-backed views, which
 * TypeScript cannot prove for a plain `Uint8Array`. Every view here comes from
 * `new Uint8Array`, `TextEncoder`, or a `fetch` response body, never from shared
 * memory.
 */
const asBufferSource = (view: Uint8Array): BufferSource => view as BufferSource;

/**
 * Metadata travelling inside the sealed payload.
 *
 * `roomId` and `excalidrawFileId` are also bound into the seal, so they cannot
 * be swapped by anybody without the room key. They are still carried and still
 * checked, because the read-side cross-check is what catches the one failure the
 * seal cannot: a storage object filed under the wrong record. That check is the
 * accepted substitute for server-side identity verification (ADR 0001) — the
 * server cannot verify a file id it has no key to compute.
 */
const assetPayloadMetadataSchema = z.strictObject({
  payloadVersion: z.literal(ASSET_PAYLOAD_VERSION),
  /** The wire protocol the asset was produced under. */
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  roomId: roomIdSchema,
  excalidrawFileId: excalidrawFileIdSchema,
  mimeType: collaborationAssetMimeTypeSchema,
});

/**
 * Checks that a data URL is what its metadata says it is.
 *
 * Two fields describe the same bytes — the metadata `mimeType` the engine will be
 * handed, and the media type inside the data URL itself — and a payload where they
 * disagree is one where the reader would render something other than what it was
 * told it was rendering. The engine produces them from one `File`, so they always
 * match in practice (verified against this project's whole stored asset corpus);
 * a mismatch therefore means the payload was assembled by something else.
 *
 * Deliberately *not* a content-hash check. An Excalidraw file id is the SHA-1 of
 * the file the user picked, while the stored data URL is the engine's possibly
 * *resized* re-encoding of it, so the digest legitimately differs for any image
 * large enough to be downscaled — 41 of this project's 67 stored assets are in
 * that state. Verifying it would reject correct images (ADR 0001 records the
 * accepted limitation).
 */
const dataUrlMatchesMimeType = (
  dataUrl: string,
  mimeType: CollaborationAssetMimeType,
): boolean => {
  const prefix = `data:${mimeType};base64,`;
  return dataUrl.startsWith(prefix) && dataUrl.length > prefix.length;
};

export type AssetPayload = {
  excalidrawFileId: ExcalidrawAssetId;
  mimeType: CollaborationAssetMimeType;
  /** The engine's `BinaryFileData.dataURL`, verbatim. */
  dataUrl: string;
};

export type AssetPayloadError =
  | { code: "oversize-asset"; byteLength: number; maxByteLength: number }
  | { code: "unsupported-mime-type"; detail: string }
  | { code: "malformed-asset"; detail: string }
  | { code: "unknown-payload-version"; receivedVersion: number | undefined }
  /** Decoded cleanly, but not the asset the caller asked for. */
  | { code: "wrong-asset"; receivedRoomId: string; receivedFileId: string };

export type EncodeAssetResult =
  { ok: true; bytes: Uint8Array } | { ok: false; error: AssetPayloadError };

export type DecodeAssetResult =
  { ok: true; payload: AssetPayload } | { ok: false; error: AssetPayloadError };

/**
 * Builds the plaintext for one asset.
 *
 * The size check is on the data URL rather than on the finished buffer, so the
 * limit a user could hit ("this image is too large for a room") is expressed in
 * the units the failure is about, and an oversize image is refused before its
 * bytes are copied anywhere.
 */
export function encodeCollaborationAssetPayload(input: {
  roomId: RoomId;
  excalidrawFileId: string;
  mimeType: string;
  dataUrl: string;
}): EncodeAssetResult {
  const metadata = assetPayloadMetadataSchema.safeParse({
    payloadVersion: ASSET_PAYLOAD_VERSION,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    roomId: input.roomId,
    excalidrawFileId: input.excalidrawFileId,
    mimeType: input.mimeType,
  });
  if (!metadata.success) {
    const detail = z.prettifyError(metadata.error);
    return {
      ok: false,
      error: COLLABORATION_ASSET_MIME_TYPES.includes(
        input.mimeType as CollaborationAssetMimeType,
      )
        ? { code: "malformed-asset", detail }
        : { code: "unsupported-mime-type", detail },
    };
  }
  if (!dataUrlMatchesMimeType(input.dataUrl, metadata.data.mimeType)) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail: `Asset is not a base64 data URL of type ${metadata.data.mimeType}`,
      },
    };
  }

  const dataUrlBytes = encoder.encode(input.dataUrl);
  if (dataUrlBytes.byteLength > MAX_ASSET_DATA_URL_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-asset",
        byteLength: dataUrlBytes.byteLength,
        maxByteLength: MAX_ASSET_DATA_URL_BYTES,
      },
    };
  }
  const metadataBytes = encoder.encode(JSON.stringify(metadata.data));
  if (metadataBytes.byteLength > MAX_ASSET_METADATA_BYTES) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail: `Asset metadata must be at most ${MAX_ASSET_METADATA_BYTES} bytes, received ${metadataBytes.byteLength}`,
      },
    };
  }

  const bytes = new Uint8Array(
    ASSET_PAYLOAD_HEADER_BYTES +
      metadataBytes.byteLength +
      dataUrlBytes.byteLength,
  );
  bytes[0] = ASSET_PAYLOAD_VERSION;
  new DataView(bytes.buffer).setUint16(VERSION_BYTES, metadataBytes.byteLength);
  bytes.set(metadataBytes, ASSET_PAYLOAD_HEADER_BYTES);
  bytes.set(
    dataUrlBytes,
    ASSET_PAYLOAD_HEADER_BYTES + metadataBytes.byteLength,
  );
  return { ok: true, bytes };
}

/**
 * Reads a plaintext asset back, and refuses anything that is not exactly the
 * asset the caller asked for.
 *
 * `expected` is the record the bytes were fetched under. Comparing it with the
 * embedded identity is what stops a wrong object served under a right record from
 * rendering one image where another belongs — the failure the seal cannot catch,
 * because sealing happens before storage chooses a key.
 */
export function decodeCollaborationAssetPayload(
  bytes: Uint8Array,
  expected: { roomId: RoomId; excalidrawFileId: string },
): DecodeAssetResult {
  // Bounded before parsing: oversize input is never decoded, whatever it holds.
  if (bytes.byteLength > MAX_ASSET_PLAINTEXT_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-asset",
        byteLength: bytes.byteLength,
        maxByteLength: MAX_ASSET_PLAINTEXT_BYTES,
      },
    };
  }
  if (bytes.byteLength <= ASSET_PAYLOAD_HEADER_BYTES) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail: `Asset payload must be longer than ${ASSET_PAYLOAD_HEADER_BYTES} bytes, received ${bytes.byteLength}`,
      },
    };
  }
  const receivedVersion = bytes[0];
  if (receivedVersion !== ASSET_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: { code: "unknown-payload-version", receivedVersion },
    };
  }

  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(VERSION_BYTES);
  const dataUrlOffset = ASSET_PAYLOAD_HEADER_BYTES + metadataLength;
  if (
    metadataLength > MAX_ASSET_METADATA_BYTES ||
    dataUrlOffset >= bytes.byteLength
  ) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail: `Asset metadata length ${metadataLength} does not fit a ${bytes.byteLength} byte payload`,
      },
    };
  }

  let raw: unknown;
  let dataUrl: string;
  try {
    raw = JSON.parse(
      decoder.decode(bytes.subarray(ASSET_PAYLOAD_HEADER_BYTES, dataUrlOffset)),
    ) as unknown;
    dataUrl = decoder.decode(bytes.subarray(dataUrlOffset));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail:
          error instanceof Error ? error.message : "Invalid asset payload",
      },
    };
  }

  const embeddedVersion =
    typeof raw === "object" && raw !== null && "payloadVersion" in raw
      ? raw.payloadVersion
      : undefined;
  if (embeddedVersion !== ASSET_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: {
        code: "unknown-payload-version",
        receivedVersion:
          typeof embeddedVersion === "number" ? embeddedVersion : undefined,
      },
    };
  }

  const metadata = assetPayloadMetadataSchema.safeParse(raw);
  if (!metadata.success) {
    const detail = z.prettifyError(metadata.error);
    const declaredMime =
      typeof raw === "object" && raw !== null && "mimeType" in raw
        ? raw.mimeType
        : undefined;
    return {
      ok: false,
      error:
        typeof declaredMime === "string" &&
        !COLLABORATION_ASSET_MIME_TYPES.includes(
          declaredMime as CollaborationAssetMimeType,
        )
          ? { code: "unsupported-mime-type", detail }
          : { code: "malformed-asset", detail },
    };
  }
  if (
    metadata.data.roomId !== expected.roomId ||
    metadata.data.excalidrawFileId !== expected.excalidrawFileId
  ) {
    return {
      ok: false,
      error: {
        code: "wrong-asset",
        receivedRoomId: metadata.data.roomId,
        receivedFileId: metadata.data.excalidrawFileId,
      },
    };
  }
  // The body has to be the kind of thing the metadata claims. Without this a
  // payload could declare an image type and carry anything at all — the MIME
  // allowlist would be checked against a field nothing else corroborates.
  if (!dataUrlMatchesMimeType(dataUrl, metadata.data.mimeType)) {
    return {
      ok: false,
      error: {
        code: "malformed-asset",
        detail: `Asset is not a base64 data URL of type ${metadata.data.mimeType}`,
      },
    };
  }

  return {
    ok: true,
    payload: {
      excalidrawFileId: metadata.data.excalidrawFileId,
      mimeType: metadata.data.mimeType,
      dataUrl,
    },
  };
}

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
 * ciphertext: envelope version, wire protocol version, room, authorization
 * generation and the asset's own file id. Binding the file id is what makes
 * serving asset A's bytes under asset B's record a decryption failure rather
 * than a rendered image in the wrong place.
 */
const assetAdditionalData = (params: {
  roomId: RoomId;
  authGeneration: number;
  excalidrawFileId: string;
}): BufferSource =>
  asBufferSource(
    encoder.encode(
      `drawstuff-asset/v${ASSET_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${params.roomId}/g${roomAuthGenerationSchema.parse(
        params.authGeneration,
      )}/${excalidrawFileIdSchema.parse(params.excalidrawFileId)}`,
    ),
  );

export async function createAssetCryptoCodec(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
}): Promise<AssetCryptoCodec> {
  const {
    roomId,
    authGeneration,
    randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length)),
  } = options;
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
      const iv = randomBytes(REALTIME_NONCE_BYTES);
      if (iv.byteLength !== REALTIME_NONCE_BYTES) {
        throw new Error(
          `randomBytes must return ${REALTIME_NONCE_BYTES} bytes, received ${iv.byteLength}`,
        );
      }
      let sealed: ArrayBuffer;
      try {
        sealed = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(iv),
            additionalData: assetAdditionalData({
              roomId,
              authGeneration,
              excalidrawFileId,
            }),
          },
          key,
          asBufferSource(plaintext),
        );
      } catch (error) {
        // The error name, never the key or the plaintext: a caller may log this.
        return {
          ok: false,
          error: {
            code: "malformed-sealed-asset",
            detail: error instanceof Error ? error.name : "Encryption failed",
          },
        };
      }
      const ciphertext = new Uint8Array(
        ASSET_SEALED_HEADER_BYTES + sealed.byteLength,
      );
      ciphertext[0] = ASSET_CRYPTO_VERSION;
      ciphertext.set(iv, VERSION_BYTES);
      ciphertext.set(new Uint8Array(sealed), ASSET_SEALED_HEADER_BYTES);
      return { ok: true, ciphertext };
    },

    async open({ excalidrawFileId, ciphertext }) {
      if (
        ciphertext.byteLength < MIN_ASSET_CIPHERTEXT_BYTES ||
        ciphertext.byteLength > MAX_ASSET_CIPHERTEXT_BYTES
      ) {
        return {
          ok: false,
          error: {
            code: "malformed-sealed-asset",
            detail: `Sealed asset must be ${MIN_ASSET_CIPHERTEXT_BYTES}..${MAX_ASSET_CIPHERTEXT_BYTES} bytes, received ${ciphertext.byteLength}`,
          },
        };
      }
      const receivedVersion = ciphertext[0];
      if (receivedVersion !== ASSET_CRYPTO_VERSION) {
        return {
          ok: false,
          error: { code: "unknown-crypto-version", receivedVersion },
        };
      }
      try {
        const opened = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(
              ciphertext.subarray(VERSION_BYTES, ASSET_SEALED_HEADER_BYTES),
            ),
            additionalData: assetAdditionalData({
              roomId,
              authGeneration,
              excalidrawFileId,
            }),
          },
          key,
          asBufferSource(ciphertext.subarray(ASSET_SEALED_HEADER_BYTES)),
        );
        return { ok: true, plaintext: new Uint8Array(opened) };
      } catch {
        // A wrong key, a rotated generation, tampered bytes and a file id that
        // does not match the seal are all the same answer: these are not bytes
        // this reader can trust.
        return { ok: false, error: { code: "authentication-failed" } };
      }
    },
  };
}
