import { z } from "zod";

import {
  COLLABORATION_ASSET_MIME_TYPES,
  collaborationAssetMimeTypeSchema,
  excalidrawFileIdSchema,
  type CollaborationAssetMimeType,
  type ExcalidrawAssetId,
} from "./asset-identity.ts";
import { roomIdSchema, type RoomId } from "./messages.ts";
import { utf8Encoder } from "./sealed-envelope.ts";

/**
 * Binary plaintext framing for one collaboration asset — the payload the
 * sealed envelope (`./asset-crypto.ts`) carries.
 *
 * The **payload** is the plaintext an asset consists of: the engine's data URL
 * plus the metadata needed to hand it back to the engine (`mimeType`) and to
 * cross-check it against the record it was fetched under (`roomId`, `fileId`).
 * It is versioned independently of the sealed envelope because the two evolve
 * on their own schedules.
 */

/** Asset payload version; bumped only on a breaking plaintext layout change. */
export const ASSET_PAYLOAD_VERSION = 1;

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

const encoder = utf8Encoder;
// Fatal so malformed UTF-8 is refused rather than repaired into a different
// (possibly valid) payload via U+FFFD replacement.
const decoder = new TextDecoder("utf-8", { fatal: true });

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
