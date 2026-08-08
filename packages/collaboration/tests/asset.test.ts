import { describe, expect, it } from "vitest";

import {
  ASSET_CRYPTO_VERSION,
  ASSET_PAYLOAD_HEADER_BYTES,
  ASSET_PAYLOAD_VERSION,
  ASSET_SEALED_HEADER_BYTES,
  ASSET_SEALED_OVERHEAD_BYTES,
  assetAdditionalDataLabel,
  canonicalizeAssetIds,
  collaborationAssetLookupSchema,
  collaborationAssetRecordSchema,
  COLLABORATION_ASSET_MIME_TYPES,
  createAssetCryptoCodec,
  decodeCollaborationAssetPayload,
  deriveAssetKey,
  encodeCollaborationAssetPayload,
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_DATA_URL_BYTES,
  MAX_ASSET_METADATA_BYTES,
  MAX_ASSET_PLAINTEXT_BYTES,
  MIN_ASSET_CIPHERTEXT_BYTES,
  type AssetCryptoCodec,
} from "../src/asset.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "../src/protocol.ts";
import { deriveSnapshotKey } from "../src/snapshot.ts";
import { roomKeySchema } from "../src/realtime-crypto.ts";
import { ROOM_ID, ROOM_KEY } from "./helpers.ts";

/**
 * Encrypted asset transfer (Plan 17).
 *
 * Two formats are under test and they fail differently, which is the point of
 * separating them:
 *
 * - The **payload** is plaintext framing. Its failures are shape failures — an
 *   unsupported MIME type, an oversize image, a metadata length that does not fit
 *   the buffer — and every one of them has to be refused rather than repaired.
 * - The **seal** is AES-GCM under a purpose-bound derived key. Its failures are
 *   all one answer (`authentication-failed`), and what the tests establish is
 *   *which* mismatches produce it: a different file id, a rotated generation,
 *   another room, a flipped bit. That set is the security contract — binding the
 *   file id is what makes "serve asset A's bytes under asset B's record" a
 *   decryption failure instead of a wrong image on somebody's canvas.
 */

const OTHER_ROOM = roomIdSchema.parse("room-beta");
const OTHER_KEY = roomKeySchema.parse(
  "T1RIRVJ2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

const FILE_A = "a".repeat(40);
const FILE_B = "b".repeat(40);

const PNG_DATA_URL = "data:image/png;base64,AAECAwQFBgcICQoLDA0ODw==";

const assetCodec = (
  overrides: {
    roomId?: typeof ROOM_ID;
    roomKey?: typeof ROOM_KEY;
    authGeneration?: number;
  } = {},
): Promise<AssetCryptoCodec> =>
  createAssetCryptoCodec({
    roomKey: overrides.roomKey ?? ROOM_KEY,
    roomId: overrides.roomId ?? ROOM_ID,
    authGeneration: overrides.authGeneration ?? 1,
  });

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
    // The storage object served under the wrong record: the one failure the seal
    // cannot catch, because sealing happens before storage chooses a key.
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

  it("refuses a payload sealed for another room", () => {
    const decoded = decodeCollaborationAssetPayload(
      payloadOf({ roomId: OTHER_ROOM }),
      { roomId: ROOM_ID, excalidrawFileId: FILE_A },
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("wrong-asset");
  });

  it("pins the byte budgets the storage layer is bounded by", () => {
    expect(MAX_ASSET_PLAINTEXT_BYTES).toBe(
      ASSET_PAYLOAD_HEADER_BYTES +
        MAX_ASSET_METADATA_BYTES +
        MAX_ASSET_DATA_URL_BYTES,
    );
    expect(MAX_ASSET_CIPHERTEXT_BYTES).toBe(
      MAX_ASSET_PLAINTEXT_BYTES + ASSET_SEALED_OVERHEAD_BYTES,
    );
    expect(MIN_ASSET_CIPHERTEXT_BYTES).toBe(ASSET_SEALED_OVERHEAD_BYTES + 1);
    // One asset must stay small enough that the whole per-generation budget is a
    // plausible amount of storage rather than an unbounded one.
    expect(MAX_ASSET_CIPHERTEXT_BYTES).toBeLessThan(4 * 1_048_576);
  });
});

describe("collaboration asset seal", () => {
  it("round-trips through the codec", async () => {
    const codec = await assetCodec();
    const plaintext = payloadOf();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(codec.cryptoVersion).toBe(ASSET_CRYPTO_VERSION);
    expect(sealed.ciphertext[0]).toBe(ASSET_CRYPTO_VERSION);
    expect(sealed.ciphertext.byteLength).toBe(
      plaintext.byteLength + ASSET_SEALED_OVERHEAD_BYTES,
    );

    const opened = await codec.open({
      excalidrawFileId: FILE_A,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(new Uint8Array(opened.plaintext)).toEqual(plaintext);
  });

  it("never emits the same IV twice", async () => {
    const codec = await assetCodec();
    const ivs = new Set<string>();
    for (let index = 0; index < 16; index += 1) {
      const sealed = await codec.seal({
        excalidrawFileId: FILE_A,
        plaintext: payloadOf(),
      });
      if (!sealed.ok) throw new Error("seal failed");
      ivs.add(sealed.ciphertext.subarray(1, 13).join(","));
    }
    expect(ivs.size).toBe(16);
  });

  it("refuses to open bytes sealed for another file id", async () => {
    const codec = await assetCodec();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext: payloadOf(),
    });
    if (!sealed.ok) throw new Error("seal failed");
    expect(
      await codec.open({
        excalidrawFileId: FILE_B,
        ciphertext: sealed.ciphertext,
      }),
    ).toEqual({ ok: false, error: { code: "authentication-failed" } });
  });

  it("refuses to open bytes from another room, generation, or room key", async () => {
    const codec = await assetCodec();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext: payloadOf(),
    });
    if (!sealed.ok) throw new Error("seal failed");

    for (const reader of await Promise.all([
      assetCodec({ roomId: OTHER_ROOM }),
      assetCodec({ authGeneration: 2 }),
      assetCodec({ roomKey: OTHER_KEY }),
    ])) {
      expect(
        await reader.open({
          excalidrawFileId: FILE_A,
          ciphertext: sealed.ciphertext,
        }),
      ).toEqual({ ok: false, error: { code: "authentication-failed" } });
    }
  });

  it("refuses tampered ciphertext", async () => {
    const codec = await assetCodec();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext: payloadOf(),
    });
    if (!sealed.ok) throw new Error("seal failed");
    const tampered = Uint8Array.from(sealed.ciphertext);
    const last = tampered.byteLength - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(
      await codec.open({ excalidrawFileId: FILE_A, ciphertext: tampered }),
    ).toEqual({ ok: false, error: { code: "authentication-failed" } });
  });

  it("refuses a ciphertext that is too short or too long to be a sealed asset", async () => {
    const codec = await assetCodec();
    for (const ciphertext of [
      new Uint8Array(MIN_ASSET_CIPHERTEXT_BYTES - 1),
      new Uint8Array(MAX_ASSET_CIPHERTEXT_BYTES + 1),
    ]) {
      const opened = await codec.open({
        excalidrawFileId: FILE_A,
        ciphertext,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.code).toBe("malformed-sealed-asset");
    }
  });

  it("refuses an unknown envelope version", async () => {
    const codec = await assetCodec();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext: payloadOf(),
    });
    if (!sealed.ok) throw new Error("seal failed");
    sealed.ciphertext[0] = ASSET_CRYPTO_VERSION + 1;
    expect(
      await codec.open({
        excalidrawFileId: FILE_A,
        ciphertext: sealed.ciphertext,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "unknown-crypto-version",
        receivedVersion: ASSET_CRYPTO_VERSION + 1,
      },
    });
  });

  it("refuses to seal a plaintext beyond the payload budget", async () => {
    const codec = await assetCodec();
    const sealed = await codec.seal({
      excalidrawFileId: FILE_A,
      plaintext: new Uint8Array(MAX_ASSET_PLAINTEXT_BYTES + 1),
    });
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.error.code).toBe("malformed-sealed-asset");
  });

  it("derives a key no other purpose can open", async () => {
    // Same room, same generation, different purpose: the asset key and the
    // snapshot key must not be interchangeable, or one leaked derived key would
    // unlock both.
    const iv = new Uint8Array(12).fill(7);
    const assetKey = await deriveAssetKey({
      roomKey: ROOM_KEY,
      roomId: ROOM_ID,
      authGeneration: 1,
    });
    const snapshotKey = await deriveSnapshotKey({
      roomKey: ROOM_KEY,
      roomId: ROOM_ID,
      authGeneration: 1,
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      assetKey,
      new Uint8Array([1, 2, 3]),
    );
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, snapshotKey, ciphertext),
    ).rejects.toThrow();
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, assetKey, ciphertext),
    ).resolves.toBeDefined();
  });
});

describe("transport protocol decoupling (Plan 31)", () => {
  // `COLLABORATION_PROTOCOL_VERSION` versions transport messages. A stored
  // asset is durable state: if the transport version reached its payload
  // metadata or its seal, a purely transport-side protocol bump would make
  // every stored asset unreadable. These tests pin that it reaches neither,
  // and that the asset's own versions still do.

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

  it("binds the seal to the asset's own versions, never the transport's", async () => {
    // The authenticated-data label is a pinned contract: envelope version,
    // room, generation, file id — no transport segment.
    expect(
      assetAdditionalDataLabel({
        roomId: ROOM_ID,
        authGeneration: 2,
        excalidrawFileId: FILE_A,
      }),
    ).toBe(`drawstuff-asset/v${ASSET_CRYPTO_VERSION}/${ROOM_ID}/g2/${FILE_A}`);

    // And it is the label sealing actually binds: the sealed bytes open under
    // exactly it, refuse the pre-decoupling label that carried the transport
    // version (so a protocol bump cannot invalidate stored assets), and refuse
    // a bumped envelope version (so the asset's own version still can).
    const codec = await assetCodec();
    const plaintext = payloadOf();
    const sealed = await codec.seal({ excalidrawFileId: FILE_A, plaintext });
    if (!sealed.ok) throw new Error("expected seal to succeed");
    const key = await deriveAssetKey({
      roomKey: ROOM_KEY,
      roomId: ROOM_ID,
      authGeneration: 1,
    });
    const iv = sealed.ciphertext.subarray(1, ASSET_SEALED_HEADER_BYTES);
    const body = sealed.ciphertext.subarray(ASSET_SEALED_HEADER_BYTES);
    const openUnder = (label: string): Promise<ArrayBuffer> =>
      crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          additionalData: new TextEncoder().encode(label) as BufferSource,
        },
        key,
        body as BufferSource,
      );

    const pinned = await openUnder(
      assetAdditionalDataLabel({
        roomId: ROOM_ID,
        authGeneration: 1,
        excalidrawFileId: FILE_A,
      }),
    );
    expect(new Uint8Array(pinned)).toEqual(plaintext);
    await expect(
      openUnder(
        `drawstuff-asset/v${ASSET_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${ROOM_ID}/g1/${FILE_A}`,
      ),
    ).rejects.toThrow();
    await expect(
      openUnder(
        `drawstuff-asset/v${ASSET_CRYPTO_VERSION + 1}/${ROOM_ID}/g1/${FILE_A}`,
      ),
    ).rejects.toThrow();
  });
});

describe("collaboration asset lookup contract", () => {
  const record = {
    excalidrawFileId: FILE_A,
    cryptoVersion: ASSET_CRYPTO_VERSION,
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

  it("refuses a byte length beyond the ciphertext budget", () => {
    expect(
      collaborationAssetRecordSchema.safeParse({
        ...record,
        byteLength: MAX_ASSET_CIPHERTEXT_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it("reports availability and absence in the same answer", () => {
    const lookup = collaborationAssetLookupSchema.parse({
      roomId: ROOM_ID,
      authGeneration: 3,
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
