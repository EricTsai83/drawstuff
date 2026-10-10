import { z } from "zod";

import {
  roomIdSchema,
  syncedElementSchema,
  type RoomId,
  type SyncedElement,
} from "./messages.ts";
import { roomRoleCanEditScene } from "./room-auth.ts";
import type { RoomPeer } from "./transport.ts";

/**
 * Durable collaboration snapshot: the room's own baseline, independent of
 * whether anybody is connected.
 *
 * A room that empties out, or a relay that restarts, loses every in-memory copy
 * of the scene — the relay is stateless by design and holds no durable scene
 * state (ADR 0001). The snapshot is what a later joiner recovers from, and it is
 * deliberately a *separate lifecycle* from the owned-scene V4 document: the
 * owner's saved scene is written by the owner on save, this is written by
 * whichever participant is elected to, and neither ever overwrites the other.
 *
 * The server stores the encoded snapshot as is. Rooms are protected the same
 * way as owned scenes — sign-in plus the room's access rules — not by
 * end-to-end encryption, so the checksum is over the plaintext bytes and only
 * guards integrity in transit and at rest.
 *
 * What a snapshot contains is also narrower than what the realtime channel
 * carries: syncable elements only. Presence, viewport, selection, theme and the
 * collaborator list are session state and must never become durable room state.
 * `collaborationSnapshotSchema` is a strict object, so a future field can only
 * enter it deliberately.
 */

export const COLLABORATION_SNAPSHOT_PROFILE = "collaboration-snapshot";

/** Snapshot document version; bumped only on a breaking payload change. */
export const COLLABORATION_SNAPSHOT_VERSION = 1;

/**
 * Byte ceiling for one encoded snapshot, on the wire and in storage. Larger
 * than a realtime scene message (`MAX_SCENE_MESSAGE_BYTES`) because a snapshot
 * is a whole scene rather than a delta, and bounded because an unbounded
 * column is a way for an authorized member to grow the database without limit.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1_048_576;

/**
 * Snapshot revisions start at 1 and advance by one per accepted write. A writer
 * states the revision it believes is current; the store accepts the write only
 * if that is still true, which is what stops a writer holding a stale scene
 * from overwriting a newer snapshot.
 */
export const SNAPSHOT_REVISION_START = 1;
export const snapshotRevisionSchema = z.int().positive();

/**
 * Sentinel a writer passes when it believes no snapshot exists yet. Not a
 * revision: `snapshotRevisionSchema` rejects it, so it can only ever arrive
 * through the field that expects it.
 */
export const SNAPSHOT_NO_REVISION = 0;
export const expectedSnapshotRevisionSchema = z.union([
  z.literal(SNAPSHOT_NO_REVISION),
  snapshotRevisionSchema,
]);

/** SHA-256 hex; the checksum the store keeps over the encoded bytes. */
export const snapshotChecksumSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Keys that must never appear in a snapshot payload. The schema is strict, so
 * these are already rejected; the list exists so the contract test asserts the
 * *intent* rather than only the current field set.
 */
export const FORBIDDEN_SNAPSHOT_KEYS = [
  "appState",
  "collaborators",
  "presence",
  "viewport",
  "files",
] as const;

export const collaborationSnapshotSchema = z.strictObject({
  profile: z.literal(COLLABORATION_SNAPSHOT_PROFILE),
  snapshotVersion: z.literal(COLLABORATION_SNAPSHOT_VERSION),
  roomId: roomIdSchema,
  /**
   * Syncable elements only, in scene order, with the same validation the
   * realtime channel applies: identity fields pinned, element bodies passed
   * through unprojected, embedded binary asset data refused.
   */
  elements: z.array(syncedElementSchema),
});
export type CollaborationSnapshot = z.infer<typeof collaborationSnapshotSchema>;

export type SnapshotCodecError =
  | { code: "oversize-snapshot"; byteLength: number; maxByteLength: number }
  | { code: "malformed-snapshot"; detail: string }
  | {
      code: "unknown-snapshot-version";
      receivedVersion: number | undefined;
    }
  /** Decoded cleanly, but for a different room than the reader is in. */
  | { code: "wrong-room"; receivedRoomId: string };

export type EncodeSnapshotResult =
  { ok: true; bytes: Uint8Array } | { ok: false; error: SnapshotCodecError };

export type DecodeSnapshotResult =
  | { ok: true; snapshot: CollaborationSnapshot }
  | { ok: false; error: SnapshotCodecError };

const encoder = new TextEncoder();
// Fatal so malformed UTF-8 is refused rather than repaired into a different
// (possibly valid) snapshot via U+FFFD replacement.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Every view handed in comes from `TextEncoder` or a `fetch` body, never
  // shared memory, so narrowing to `BufferSource` is sound.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export function encodeCollaborationSnapshot(input: {
  roomId: RoomId;
  elements: readonly SyncedElement[];
}): EncodeSnapshotResult {
  const parsed = collaborationSnapshotSchema.safeParse({
    profile: COLLABORATION_SNAPSHOT_PROFILE,
    snapshotVersion: COLLABORATION_SNAPSHOT_VERSION,
    roomId: input.roomId,
    elements: input.elements,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: z.prettifyError(parsed.error),
      },
    };
  }

  let bytes: Uint8Array;
  try {
    // Element bodies pass validation unprojected, so a non-serializable value
    // (bigint, circular reference) surfaces here rather than on the wire.
    bytes = encoder.encode(JSON.stringify(parsed.data));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail:
          error instanceof Error ? error.message : "Unserializable snapshot",
      },
    };
  }
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-snapshot",
        byteLength: bytes.byteLength,
        maxByteLength: MAX_SNAPSHOT_BYTES,
      },
    };
  }
  return { ok: true, bytes };
}

export function decodeCollaborationSnapshot(
  bytes: Uint8Array,
  expected: { roomId: RoomId },
): DecodeSnapshotResult {
  // Bounded before parsing: oversize input is never decoded, whatever it holds.
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-snapshot",
        byteLength: bytes.byteLength,
        maxByteLength: MAX_SNAPSHOT_BYTES,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: error instanceof Error ? error.message : "Invalid JSON",
      },
    };
  }

  const receivedVersion =
    typeof raw === "object" && raw !== null && "snapshotVersion" in raw
      ? raw.snapshotVersion
      : undefined;
  if (receivedVersion !== COLLABORATION_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: {
        code: "unknown-snapshot-version",
        receivedVersion:
          typeof receivedVersion === "number" ? receivedVersion : undefined,
      },
    };
  }

  const parsed = collaborationSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: z.prettifyError(parsed.error),
      },
    };
  }
  // The store keys snapshots by room, so this can only fail on a misrouted
  // read — still refused rather than applied to the wrong canvas.
  if (parsed.data.roomId !== expected.roomId) {
    return {
      ok: false,
      error: { code: "wrong-room", receivedRoomId: parsed.data.roomId },
    };
  }
  return { ok: true, snapshot: parsed.data };
}

/**
 * Semantic digest of a snapshot's element set: the identity triple
 * reconciliation converges on, in a canonical order.
 *
 * Two clients that converged produce the same digest even though their scene
 * arrays may differ in object identity, and a scene recovered from a snapshot
 * produces the same digest as the scene it was taken from. Used by the session
 * to skip a redundant snapshot write, and by tests as the convergence oracle.
 */
export async function collaborationSnapshotDigest(
  elements: readonly SyncedElement[],
): Promise<string> {
  const canonical = [...elements]
    .map(
      (element) =>
        `${element.id}:${element.version}:${element.versionNonce}:${
          element.isDeleted ? 1 : 0
        }`,
    )
    .sort()
    .join("\n");
  return sha256Hex(encoder.encode(canonical));
}

/** Checksum the store keeps over the encoded snapshot bytes. */
export function snapshotChecksum(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/**
 * Picks the single participant responsible for writing snapshots.
 *
 * Every member computes this from the membership list the relay broadcast, so
 * they all reach the same answer without a coordination round-trip, and the
 * smallest peer id is a total order that does not depend on join timing. Only a
 * peer that may edit the scene is eligible: a viewer's write would be refused by
 * the server anyway, and electing one would leave the room with no writer at
 * all.
 *
 * Returns `undefined` when the room has no eligible member — a viewers-only
 * room simply keeps whatever snapshot it already had.
 */
export function electSnapshotWriter(
  peers: readonly RoomPeer[],
): RoomPeer | undefined {
  let elected: RoomPeer | undefined;
  for (const peer of peers) {
    if (!roomRoleCanEditScene(peer.role)) continue;
    if (elected === undefined || peer.peerId < elected.peerId) elected = peer;
  }
  return elected;
}
