import { describe, expect, it } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  peerIdSchema,
  roomIdSchema,
  type SyncedElement,
} from "../src/protocol.ts";
import { roomKeySchema } from "../src/realtime-crypto.ts";
import {
  collaborationSnapshotDigest,
  collaborationSnapshotSchema,
  decodeCollaborationSnapshot,
  deriveSnapshotKey,
  electSnapshotWriter,
  encodeCollaborationSnapshot,
  FORBIDDEN_SNAPSHOT_KEYS,
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
  openCollaborationSnapshot,
  sealCollaborationSnapshot,
  snapshotAdditionalDataLabel,
  snapshotCiphertextChecksum,
  SNAPSHOT_CRYPTO_VERSION,
  SNAPSHOT_SEALED_HEADER_BYTES,
  SNAPSHOT_SEALED_OVERHEAD_BYTES,
} from "../src/snapshot.ts";
import type { RoomPeer } from "../src/transport.ts";
import { element, ROOM_ID, ROOM_KEY } from "./helpers.ts";

const OTHER_ROOM = roomIdSchema.parse("room-beta");
const OTHER_KEY = roomKeySchema.parse(
  "T1RIRVJ2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

const snapshotKey = (
  overrides: { roomId?: typeof ROOM_ID; authGeneration?: number } = {},
): Promise<CryptoKey> =>
  deriveSnapshotKey({
    roomKey: ROOM_KEY,
    roomId: overrides.roomId ?? ROOM_ID,
    authGeneration: overrides.authGeneration ?? 1,
  });

/** Returns a copy with one byte inverted, for tamper-detection assertions. */
const flipByte = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
};

const elements = (count: number): SyncedElement[] =>
  Array.from({ length: count }, (_, index) =>
    element({ id: `el-${index}`, version: index + 1, versionNonce: index }),
  );

const seal = async (
  plaintext: Uint8Array,
  overrides: {
    key?: CryptoKey;
    roomId?: typeof ROOM_ID;
    authGeneration?: number;
    revision?: number;
  } = {},
): Promise<Uint8Array> => {
  const sealed = await sealCollaborationSnapshot({
    key: overrides.key ?? (await snapshotKey()),
    plaintext,
    roomId: overrides.roomId ?? ROOM_ID,
    authGeneration: overrides.authGeneration ?? 1,
    revision: overrides.revision ?? 1,
  });
  if (!sealed.ok)
    throw new Error(`expected seal to succeed: ${sealed.error.code}`);
  return sealed.ciphertext;
};

describe("collaboration snapshot codec", () => {
  it("round-trips syncable elements for the room it was taken from", () => {
    const encoded = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: elements(3),
    });
    if (!encoded.ok) throw new Error("expected encodable snapshot");

    const decoded = decodeCollaborationSnapshot(encoded.bytes, {
      roomId: ROOM_ID,
    });
    if (!decoded.ok) throw new Error("expected decodable snapshot");
    expect(decoded.snapshot.profile).toBe("collaboration-snapshot");
    expect(decoded.snapshot.snapshotVersion).toBe(1);
    expect(decoded.snapshot.elements.map((el) => el.id)).toEqual([
      "el-0",
      "el-1",
      "el-2",
    ]);
  });

  it("refuses presence, viewport, appState and file payloads", () => {
    for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
      const raw = JSON.stringify({
        profile: "collaboration-snapshot",
        snapshotVersion: 1,
        roomId: ROOM_ID,
        elements: [],
        [key]: { anything: true },
      });
      const decoded = decodeCollaborationSnapshot(
        new TextEncoder().encode(raw),
        { roomId: ROOM_ID },
      );
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.code).toBe("malformed-snapshot");
    }
  });

  it("refuses binary asset data embedded in an element", () => {
    const encoded = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: [
        { ...element({ id: "img" }), dataURL: "data:image/png;base64,AA" },
      ],
    });
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error.code).toBe("malformed-snapshot");
  });

  it("rejects a snapshot decoded for a different room", () => {
    const encoded = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: elements(1),
    });
    if (!encoded.ok) throw new Error("expected encodable snapshot");
    const decoded = decodeCollaborationSnapshot(encoded.bytes, {
      roomId: OTHER_ROOM,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe("wrong-room");
    }
  });

  it("rejects an unknown snapshot version before validating anything else", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ snapshotVersion: 99, elements: "nonsense" }),
    );
    const decoded = decodeCollaborationSnapshot(raw, { roomId: ROOM_ID });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toEqual({
        code: "unknown-snapshot-version",
        receivedVersion: 99,
      });
    }
  });

  it("bounds plaintext on both encode and decode", () => {
    const oversize = new Uint8Array(MAX_SNAPSHOT_PLAINTEXT_BYTES + 1);
    const decoded = decodeCollaborationSnapshot(oversize, { roomId: ROOM_ID });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toEqual({
        code: "oversize-snapshot",
        byteLength: oversize.byteLength,
        maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
      });
    }

    // One giant text field is the cheapest way past the element-count budget.
    const huge = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: [
        { ...element(), text: "x".repeat(MAX_SNAPSHOT_PLAINTEXT_BYTES) },
      ],
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error.code).toBe("oversize-snapshot");
  });

  it("keeps the ciphertext bound consistent with the plaintext bound", () => {
    expect(MAX_SNAPSHOT_CIPHERTEXT_BYTES).toBe(
      MAX_SNAPSHOT_PLAINTEXT_BYTES + SNAPSHOT_SEALED_OVERHEAD_BYTES,
    );
  });
});

describe("collaboration snapshot digest", () => {
  it("is order-independent and identity-sensitive", async () => {
    const forward = elements(4);
    const reversed = [...forward].reverse();
    expect(await collaborationSnapshotDigest(forward)).toBe(
      await collaborationSnapshotDigest(reversed),
    );

    const bumped = [...forward.slice(0, 3), { ...forward[3]!, version: 99 }];
    expect(await collaborationSnapshotDigest(bumped)).not.toBe(
      await collaborationSnapshotDigest(forward),
    );
  });

  it("distinguishes a tombstone from a live element", async () => {
    const live = [element({ id: "a" })];
    const deleted = [element({ id: "a", isDeleted: true })];
    expect(await collaborationSnapshotDigest(live)).not.toBe(
      await collaborationSnapshotDigest(deleted),
    );
  });
});

describe("collaboration snapshot sealing", () => {
  it("seals and opens under the matching room, generation and revision", async () => {
    const key = await snapshotKey();
    const plaintext = new TextEncoder().encode("scene bytes");
    const ciphertext = await seal(plaintext, { key, revision: 4 });

    expect(ciphertext[0]).toBe(SNAPSHOT_CRYPTO_VERSION);
    expect(ciphertext.byteLength).toBe(
      plaintext.byteLength + SNAPSHOT_SEALED_OVERHEAD_BYTES,
    );
    // The plaintext must not be recoverable from the stored bytes.
    expect(new TextDecoder().decode(ciphertext)).not.toContain("scene bytes");

    const opened = await openCollaborationSnapshot({
      key,
      ciphertext,
      roomId: ROOM_ID,
      authGeneration: 1,
      revision: 4,
    });
    if (!opened.ok) throw new Error("expected the snapshot to open");
    expect(new TextDecoder().decode(opened.plaintext)).toBe("scene bytes");
  });

  it("refuses the wrong key, a rotated generation, and a swapped revision", async () => {
    const plaintext = new TextEncoder().encode("scene bytes");
    const ciphertext = await seal(plaintext, { revision: 2 });

    const wrongKey = await deriveSnapshotKey({
      roomKey: OTHER_KEY,
      roomId: ROOM_ID,
      authGeneration: 1,
    });
    const rotated = await deriveSnapshotKey({
      roomKey: ROOM_KEY,
      roomId: ROOM_ID,
      authGeneration: 2,
    });
    const key = await snapshotKey();

    for (const attempt of [
      { key: wrongKey, authGeneration: 1, revision: 2 },
      { key: rotated, authGeneration: 2, revision: 2 },
      // Same bytes offered as a different revision: the metadata is
      // authenticated, so a store cannot mix revision N's bytes with
      // revision M's row.
      { key, authGeneration: 1, revision: 3 },
    ]) {
      const opened = await openCollaborationSnapshot({
        ciphertext,
        roomId: ROOM_ID,
        ...attempt,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.code).toBe("authentication-failed");
    }
  });

  it("refuses a snapshot sealed for another room", async () => {
    const ciphertext = await seal(new TextEncoder().encode("x"));
    const opened = await openCollaborationSnapshot({
      key: await snapshotKey(),
      ciphertext,
      roomId: OTHER_ROOM,
      authGeneration: 1,
      revision: 1,
    });
    expect(opened.ok).toBe(false);
  });

  it("uses a key that neither realtime traffic nor another purpose shares", async () => {
    const plaintext = new TextEncoder().encode("scene bytes");
    const ciphertext = await seal(plaintext);
    // Tampering with one ciphertext byte must fail authentication rather than
    // yield different plaintext.
    const tampered = flipByte(ciphertext, ciphertext.byteLength - 1);
    const opened = await openCollaborationSnapshot({
      key: await snapshotKey(),
      ciphertext: tampered,
      roomId: ROOM_ID,
      authGeneration: 1,
      revision: 1,
    });
    expect(opened.ok).toBe(false);
  });

  it("refuses envelopes that are too short, too long, or a foreign version", async () => {
    const key = await snapshotKey();
    const base = {
      key,
      roomId: ROOM_ID,
      authGeneration: 1,
      revision: 1,
    } as const;

    const short = await openCollaborationSnapshot({
      ...base,
      ciphertext: new Uint8Array(MIN_SNAPSHOT_SEALED_BYTES - 1),
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.code).toBe("malformed-sealed-snapshot");

    const long = await openCollaborationSnapshot({
      ...base,
      ciphertext: new Uint8Array(MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe("malformed-sealed-snapshot");

    const foreign = new Uint8Array(MIN_SNAPSHOT_SEALED_BYTES);
    foreign[0] = SNAPSHOT_CRYPTO_VERSION + 1;
    const unknown = await openCollaborationSnapshot({
      ...base,
      ciphertext: foreign,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toEqual({
        code: "unknown-crypto-version",
        receivedVersion: SNAPSHOT_CRYPTO_VERSION + 1,
      });
    }
  });

  it("uses a fresh IV per write, so equal scenes produce different bytes", async () => {
    const plaintext = new TextEncoder().encode("same scene");
    const first = await seal(plaintext);
    const second = await seal(plaintext);
    expect(Array.from(first)).not.toEqual(Array.from(second));
    // Different bytes, so different checksums: the stored checksum reveals
    // nothing about whether two snapshots hold the same scene.
    expect(await snapshotCiphertextChecksum(first)).not.toBe(
      await snapshotCiphertextChecksum(second),
    );
  });

  it("checksums the ciphertext, and the checksum changes when bytes do", async () => {
    const ciphertext = await seal(new TextEncoder().encode("scene"));
    const checksum = await snapshotCiphertextChecksum(ciphertext);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    expect(await snapshotCiphertextChecksum(flipByte(ciphertext, 1))).not.toBe(
      checksum,
    );
  });
});

describe("transport protocol decoupling (Plan 31)", () => {
  // `COLLABORATION_PROTOCOL_VERSION` versions transport messages. A snapshot is
  // durable state: if the transport version reached its payload schema or its
  // seal, a purely transport-side protocol bump would make every stored
  // snapshot unreadable. These tests pin that it reaches neither, and that the
  // snapshot's own versions still do.

  it("keeps the transport protocol version out of the payload schema", () => {
    expect(Object.keys(collaborationSnapshotSchema.shape)).toEqual([
      "profile",
      "snapshotVersion",
      "roomId",
      "elements",
    ]);
  });

  it("refuses a pre-decoupling payload that still carries protocolVersion", () => {
    // The strict schema makes dropping the field a breaking change for stored
    // payloads. That is deliberate and deployed by draining rooms (audited: no
    // stored snapshots existed), so the legacy shape must be refused, not
    // silently tolerated.
    const raw = JSON.stringify({
      profile: "collaboration-snapshot",
      snapshotVersion: 1,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      elements: [],
    });
    const decoded = decodeCollaborationSnapshot(new TextEncoder().encode(raw), {
      roomId: ROOM_ID,
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("malformed-snapshot");
  });

  it("binds the seal to the snapshot's own versions, never the transport's", async () => {
    // The authenticated-data label is a pinned contract: envelope version,
    // room, generation, revision — no transport segment.
    expect(
      snapshotAdditionalDataLabel({
        roomId: ROOM_ID,
        authGeneration: 2,
        revision: 7,
      }),
    ).toBe(`drawstuff-snapshot/v${SNAPSHOT_CRYPTO_VERSION}/${ROOM_ID}/g2/r7`);

    // And it is the label sealing actually binds: the sealed bytes open under
    // exactly it, refuse the pre-decoupling label that carried the transport
    // version (so a protocol bump cannot invalidate stored snapshots), and
    // refuse a bumped envelope version (so the snapshot's own version still
    // can).
    const key = await snapshotKey();
    const plaintext = new TextEncoder().encode("scene bytes");
    const ciphertext = await seal(plaintext, { key });
    const iv = ciphertext.subarray(1, SNAPSHOT_SEALED_HEADER_BYTES);
    const body = ciphertext.subarray(SNAPSHOT_SEALED_HEADER_BYTES);
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
      snapshotAdditionalDataLabel({
        roomId: ROOM_ID,
        authGeneration: 1,
        revision: 1,
      }),
    );
    expect(new Uint8Array(pinned)).toEqual(plaintext);
    await expect(
      openUnder(
        `drawstuff-snapshot/v${SNAPSHOT_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${ROOM_ID}/g1/r1`,
      ),
    ).rejects.toThrow();
    await expect(
      openUnder(
        `drawstuff-snapshot/v${SNAPSHOT_CRYPTO_VERSION + 1}/${ROOM_ID}/g1/r1`,
      ),
    ).rejects.toThrow();
  });
});

describe("electSnapshotWriter", () => {
  const peer = (name: string, role: RoomPeer["role"]): RoomPeer => ({
    peerId: peerIdSchema.parse(name),
    role,
  });

  it("picks the smallest peer id, so every member agrees without coordinating", () => {
    const peers = [peer("peer-c", "editor"), peer("peer-a", "editor")];
    expect(electSnapshotWriter(peers)?.peerId).toBe("peer-a");
    // Order of the membership list must not change the answer.
    expect(electSnapshotWriter([...peers].reverse())?.peerId).toBe("peer-a");
  });

  it("never elects a viewer, even when it sorts first", () => {
    const peers = [peer("peer-a", "viewer"), peer("peer-b", "editor")];
    expect(electSnapshotWriter(peers)?.peerId).toBe("peer-b");
  });

  it("elects nobody in a viewers-only room", () => {
    expect(
      electSnapshotWriter([peer("peer-a", "viewer"), peer("peer-b", "viewer")]),
    ).toBeUndefined();
    expect(electSnapshotWriter([])).toBeUndefined();
  });

  it("hands the role over deterministically when the writer leaves", () => {
    const all = [
      peer("peer-a", "editor"),
      peer("peer-b", "editor"),
      peer("peer-c", "editor"),
    ];
    expect(electSnapshotWriter(all)?.peerId).toBe("peer-a");
    // A crashed writer must not block the room: the next election picks up.
    expect(electSnapshotWriter(all.slice(1))?.peerId).toBe("peer-b");
  });
});
