import { describe, expect, it } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  peerIdSchema,
  roomIdSchema,
  type SyncedElement,
} from "../src/protocol.ts";
import {
  collaborationSnapshotDigest,
  collaborationSnapshotSchema,
  decodeCollaborationSnapshot,
  electSnapshotWriter,
  encodeCollaborationSnapshot,
  FORBIDDEN_SNAPSHOT_KEYS,
  MAX_SNAPSHOT_BYTES,
  snapshotChecksum,
} from "../src/snapshot.ts";
import type { RoomPeer } from "../src/transport.ts";
import { element, ROOM_ID } from "./helpers.ts";

const OTHER_ROOM = roomIdSchema.parse("room-beta");
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

  it("bounds the encoded bytes on both encode and decode", () => {
    const oversize = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
    const decoded = decodeCollaborationSnapshot(oversize, { roomId: ROOM_ID });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toEqual({
        code: "oversize-snapshot",
        byteLength: oversize.byteLength,
        maxByteLength: MAX_SNAPSHOT_BYTES,
      });
    }

    // One giant text field is the cheapest way past the element-count budget.
    const huge = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: [{ ...element(), text: "x".repeat(MAX_SNAPSHOT_BYTES) }],
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error.code).toBe("oversize-snapshot");
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

describe("snapshot checksum", () => {
  it("is the SHA-256 of the stored bytes, which are the encoded snapshot as is", async () => {
    const encoded = encodeCollaborationSnapshot({
      roomId: ROOM_ID,
      elements: elements(2),
    });
    if (!encoded.ok) throw new Error("expected encodable snapshot");
    // Rooms are not end-to-end encrypted: what the store keeps is readable
    // JSON, and the checksum only guards integrity.
    expect(new TextDecoder().decode(encoded.bytes)).toContain('"el-1"');

    expect(await snapshotChecksum(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const checksum = await snapshotChecksum(encoded.bytes);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(await snapshotChecksum(Uint8Array.from(encoded.bytes))).toBe(
      checksum,
    );
    expect(await snapshotChecksum(flipByte(encoded.bytes, 1))).not.toBe(
      checksum,
    );
  });
});

describe("transport protocol decoupling (Plan 31)", () => {
  // `COLLABORATION_PROTOCOL_VERSION` versions transport messages. A snapshot is
  // durable state: if the transport version reached its payload schema, a
  // purely transport-side protocol bump would make every stored snapshot
  // unreadable. These tests pin that it does not.

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
