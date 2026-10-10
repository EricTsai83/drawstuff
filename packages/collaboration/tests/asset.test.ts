import { describe, expect, it } from "vitest";

import {
  ASSET_PAYLOAD_HEADER_BYTES,
  ASSET_PAYLOAD_VERSION,
  canonicalizeAssetIds,
  collaborationAssetLookupSchema,
  collaborationAssetRecordSchema,
  COLLABORATION_ASSET_MIME_TYPES,
  decodeCollaborationAssetPayload,
  encodeCollaborationAssetPayload,
  MAX_ASSET_BYTES,
  MAX_ASSET_DATA_URL_BYTES,
  MAX_ASSET_METADATA_BYTES,
  MAX_ROOM_ASSETS,
  MIN_ASSET_BYTES,
} from "../src/asset.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "../src/protocol.ts";
import { ROOM_ID } from "./helpers.ts";

/**
 * Collaboration asset transfer (Plan 17, plan 21).
 *
 * Room assets are stored as the payload framing itself, not encrypted, so the
 * payload's failures are the whole contract: an unsupported MIME type, an
 * oversize image, a metadata length that does not fit the buffer, an embedded
 * identity that is not the one requested. Every one of them has to be refused
 * rather than repaired — the identity check is what makes "serve asset A's
 * bytes under asset B's record" a refusal instead of a wrong image on
 * somebody's canvas.
 */

const OTHER_ROOM = roomIdSchema.parse("room-beta");

const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);

const PNG_DATA_URL = "data:image/png;base64,AAECAwQFBgcICQoLDA0ODw==";

const payloadOf = (
  overrides: {
    roomId?: typeof ROOM_ID;
    excalidrawFileId?: string;
    mimeType?: string;
    dataUrl?: string;
  } = {},
): Uint8Array => {
  const encoded = encodeCollaborationAssetPayload({
    roomId: overrides.roomId ?? ROOM_ID,
    excalidrawFileId: overrides.excalidrawFileId ?? FILE_A,
    mimeType: overrides.mimeType ?? "image/png",
    dataUrl: overrides.dataUrl ?? PNG_DATA_URL,
  });
  if (!encoded.ok) throw new Error(`encode failed: ${encoded.error.code}`);
  return encoded.bytes;
};

describe("collaboration asset payload", () => {
  it("round-trips a data URL with its MIME type and identity", () => {
    const decoded = decodeCollaborationAssetPayload(payloadOf(), {
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
    });
    expect(decoded).toEqual({
      ok: true,
      payload: {
        excalidrawFileId: FILE_A,
        mimeType: "image/png",
        dataUrl: PNG_DATA_URL,
      },
    });
  });

  it("carries the data URL verbatim rather than JSON-escaped", () => {
    // The framing exists so the largest field is copied once. If it were wrapped
    // in JSON the payload would contain quotes around it and grow by escaping.
    const bytes = payloadOf();
    const tail = new TextDecoder().decode(
      bytes.subarray(bytes.byteLength - PNG_DATA_URL.length),
    );
    expect(tail).toBe(PNG_DATA_URL);
  });

  it("accepts every MIME type the engine can render, and nothing else", () => {
    for (const mimeType of COLLABORATION_ASSET_MIME_TYPES) {
      const encoded = encodeCollaborationAssetPayload({
        roomId: ROOM_ID,
        excalidrawFileId: FILE_A,
        mimeType,
        dataUrl: `data:${mimeType};base64,AAECAwQFBgcICQoLDA0ODw==`,
      });
      expect(encoded.ok).toBe(true);
    }
    // `BinaryFileData.mimeType` also admits this one; a room asset must not.
    const binary = encodeCollaborationAssetPayload({
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
      mimeType: "application/octet-stream",
      dataUrl: PNG_DATA_URL,
    });
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.error.code).toBe("unsupported-mime-type");
  });

  it("refuses a body that is not a base64 data URL of the declared type", () => {
    for (const dataUrl of [
      "https://example.com/cat.png",
      // Right shape, wrong media type: the allowlist would otherwise be checked
      // against a metadata field nothing corroborates.
      "data:text/html;base64,PHNjcmlwdD4=",
      // Declared type, but not base64 — the reader would hand the engine bytes it
      // cannot decode.
      "data:image/png,notbase64",
      // Empty body.
      "data:image/png;base64,",
    ]) {
      const encoded = encodeCollaborationAssetPayload({
        roomId: ROOM_ID,
        excalidrawFileId: FILE_A,
        mimeType: "image/png",
        dataUrl,
      });
      expect(encoded.ok).toBe(false);
      if (!encoded.ok) expect(encoded.error.code).toBe("malformed-asset");
    }
  });

  it("refuses a decoded body whose media type contradicts its metadata", () => {
    // Assembled by hand: only something other than the encoder could produce a
    // payload whose metadata and body disagree, which is exactly why it is checked.
    const bytes = payloadOf();
    const rewritten = new TextDecoder()
      .decode(bytes.subarray(ASSET_PAYLOAD_HEADER_BYTES))
      .replace("data:image/png;base64,", "data:image/gif;base64,");
    const metadataLength = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint16(1);
    const encoder = new TextEncoder();
    const tail = encoder.encode(rewritten);
    const forged = new Uint8Array(ASSET_PAYLOAD_HEADER_BYTES + tail.byteLength);
    forged.set(bytes.subarray(0, ASSET_PAYLOAD_HEADER_BYTES));
    forged.set(tail, ASSET_PAYLOAD_HEADER_BYTES);
    new DataView(forged.buffer).setUint16(1, metadataLength);

    const decoded = decodeCollaborationAssetPayload(forged, {
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("malformed-asset");
  });

  it("refuses an oversize payload before decoding it", () => {
    const decoded = decodeCollaborationAssetPayload(
      new Uint8Array(MAX_ASSET_BYTES + 1),
      { roomId: ROOM_ID, excalidrawFileId: FILE_A },
    );
    expect(decoded).toEqual({
      ok: false,
      error: {
        code: "oversize-asset",
        byteLength: MAX_ASSET_BYTES + 1,
        maxByteLength: MAX_ASSET_BYTES,
      },
    });
  });

  it("refuses an oversize data URL before copying it", () => {
    const oversize = `data:image/png;base64,${"A".repeat(
      MAX_ASSET_DATA_URL_BYTES,
    )}`;
    const encoded = encodeCollaborationAssetPayload({
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
      mimeType: "image/png",
      dataUrl: oversize,
    });
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) {
      expect(encoded.error).toEqual({
        code: "oversize-asset",
        byteLength: oversize.length,
        maxByteLength: MAX_ASSET_DATA_URL_BYTES,
      });
    }
  });

  it("refuses an unknown payload version", () => {
    const bytes = payloadOf();
    bytes[0] = ASSET_PAYLOAD_VERSION + 1;
    expect(
      decodeCollaborationAssetPayload(bytes, {
        roomId: ROOM_ID,
        excalidrawFileId: FILE_A,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "unknown-payload-version",
        receivedVersion: ASSET_PAYLOAD_VERSION + 1,
      },
    });
  });

  it("refuses a metadata length that does not fit the buffer", () => {
    const bytes = payloadOf();
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
      1,
      bytes.byteLength,
    );
    const decoded = decodeCollaborationAssetPayload(bytes, {
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("malformed-asset");
  });

  it("refuses a truncated payload", () => {
    const decoded = decodeCollaborationAssetPayload(
      payloadOf().subarray(0, ASSET_PAYLOAD_HEADER_BYTES),
      { roomId: ROOM_ID, excalidrawFileId: FILE_A },
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("malformed-asset");
  });

  it("refuses a payload whose embedded identity is not the one requested", () => {
    // The storage object served under the wrong record.
    const decoded = decodeCollaborationAssetPayload(payloadOf(), {
      roomId: ROOM_ID,
      excalidrawFileId: FILE_B,
    });
    expect(decoded).toEqual({
      ok: false,
      error: {
        code: "wrong-asset",
        receivedRoomId: ROOM_ID,
        receivedFileId: FILE_A,
      },
    });
  });

  it("refuses a payload encoded for another room", () => {
    const decoded = decodeCollaborationAssetPayload(
      payloadOf({ roomId: OTHER_ROOM }),
      { roomId: ROOM_ID, excalidrawFileId: FILE_A },
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("wrong-asset");
  });

  it("pins the byte budgets the storage layer is bounded by", () => {
    expect(MAX_ASSET_BYTES).toBe(
      ASSET_PAYLOAD_HEADER_BYTES +
        MAX_ASSET_METADATA_BYTES +
        MAX_ASSET_DATA_URL_BYTES,
    );
    expect(MIN_ASSET_BYTES).toBe(ASSET_PAYLOAD_HEADER_BYTES + 1);
    expect(payloadOf().byteLength).toBeGreaterThanOrEqual(MIN_ASSET_BYTES);
    // One asset must stay small enough that the whole per-room budget is a
    // plausible amount of storage rather than an unbounded one.
    expect(MAX_ASSET_BYTES).toBeLessThan(4 * 1_048_576);
    expect(MAX_ROOM_ASSETS).toBe(512);
  });
});

describe("transport protocol decoupling (Plan 31)", () => {
  // `COLLABORATION_PROTOCOL_VERSION` versions transport messages. A stored
  // asset is durable state: if the transport version reached its payload
  // metadata, a purely transport-side protocol bump would make every stored
  // asset unreadable. This pins that it does not.

  it("refuses a pre-decoupling payload whose metadata still carries protocolVersion", () => {
    // The strict metadata schema makes dropping the field a breaking change
    // for stored payloads. That is deliberate and deployed by draining rooms
    // (audited: no stored assets existed), so the legacy shape must be
    // refused, not silently tolerated.
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({
        payloadVersion: ASSET_PAYLOAD_VERSION,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId: ROOM_ID,
        excalidrawFileId: FILE_A,
        mimeType: "image/png",
      }),
    );
    const dataUrlBytes = new TextEncoder().encode(PNG_DATA_URL);
    const bytes = new Uint8Array(
      ASSET_PAYLOAD_HEADER_BYTES +
        metadataBytes.byteLength +
        dataUrlBytes.byteLength,
    );
    bytes[0] = ASSET_PAYLOAD_VERSION;
    new DataView(bytes.buffer).setUint16(1, metadataBytes.byteLength);
    bytes.set(metadataBytes, ASSET_PAYLOAD_HEADER_BYTES);
    bytes.set(
      dataUrlBytes,
      ASSET_PAYLOAD_HEADER_BYTES + metadataBytes.byteLength,
    );

    const decoded = decodeCollaborationAssetPayload(bytes, {
      roomId: ROOM_ID,
      excalidrawFileId: FILE_A,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("malformed-asset");
  });
});

describe("collaboration asset lookup contract", () => {
  const record = {
    excalidrawFileId: FILE_A,
    byteLength: 128,
    url: "https://storage.example.com/objects/abc",
  };

  it("accepts a well-formed record", () => {
    expect(collaborationAssetRecordSchema.parse(record)).toEqual(record);
  });

  it("refuses a plain-HTTP asset URL", () => {
    expect(
      collaborationAssetRecordSchema.safeParse({
        ...record,
        url: "http://storage.example.com/objects/abc",
      }).success,
    ).toBe(false);
  });

  it("refuses a byte length beyond the payload budget, or a crypto version", () => {
    expect(
      collaborationAssetRecordSchema.safeParse({
        ...record,
        byteLength: MAX_ASSET_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      collaborationAssetRecordSchema.safeParse({ ...record, cryptoVersion: 1 })
        .success,
    ).toBe(false);
  });

  it("reports availability and absence in the same answer", () => {
    const lookup = collaborationAssetLookupSchema.parse({
      roomId: ROOM_ID,
      assets: [record],
      missing: [FILE_B],
    });
    expect(lookup.assets).toHaveLength(1);
    expect(lookup.missing).toEqual([FILE_B]);
  });

  it("deduplicates and orders a requested batch", () => {
    expect(canonicalizeAssetIds([FILE_B, FILE_A, FILE_B])).toEqual([
      FILE_A,
      FILE_B,
    ]);
  });
});
