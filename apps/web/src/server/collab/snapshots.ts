import "server-only";

import { and, eq, lt } from "drizzle-orm";

import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  SNAPSHOT_NO_REVISION,
  SNAPSHOT_REVISION_START,
} from "@drawstuff/collaboration/snapshot";

import { collaborationSnapshot } from "@/server/db/schema";
import type { RoomDatabase } from "@/server/collab/rooms";

/**
 * Durable snapshot storage for one room generation.
 *
 * The server's whole job here is to hold an opaque byte string and to order
 * writes correctly. It never derives a key, never decodes a payload, and never
 * inspects an element — so the only thing it can get wrong is the ordering, and
 * that is what this module is about.
 *
 * Ordering is optimistic, not lock-based: a writer states the revision it
 * believes is current and the write lands only if that is still true. Two things
 * follow, and both matter for a room whose writer can vanish at any moment:
 *
 * - A writer holding a stale scene cannot overwrite a newer snapshot. Its
 *   conditional update matches nothing and it is told the current revision.
 * - No lock is held across a client's think time. A crashed writer blocks
 *   nobody: the next elected writer simply writes at the revision it read.
 *
 * Retention is bounded by construction. One row per (room, generation), and a
 * write retires every older generation's row — a rotated generation's ciphertext
 * is cryptographically unreadable, so keeping it would only be storage nobody
 * can ever use.
 */

export type SnapshotRecord = {
  roomId: string;
  authGeneration: number;
  revision: number;
  cryptoVersion: number;
  ciphertext: Uint8Array;
  byteLength: number;
  checksum: string;
  updatedAt: Date;
};

export type SnapshotWriteResult =
  | { status: "written"; revision: number }
  /**
   * Another writer moved the snapshot on. `currentRevision` is what the caller
   * has to base its next attempt on; `undefined` means the row disappeared
   * (the room's generation was rotated or the room was deleted).
   */
  | { status: "conflict"; currentRevision: number | undefined };

/** Reads the baseline for one room generation, or `null` when none exists. */
export async function readRoomSnapshot(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number },
): Promise<SnapshotRecord | null> {
  const row = await db.query.collaborationSnapshot.findFirst({
    where: and(
      eq(collaborationSnapshot.roomId, params.roomId),
      eq(collaborationSnapshot.authGeneration, params.authGeneration),
    ),
  });
  return row ?? null;
}

/**
 * Conditional write. `expectedRevision` is either
 * {@link SNAPSHOT_NO_REVISION} — "I believe this generation has no snapshot
 * yet" — or the revision the writer read.
 *
 * The create path uses `onConflictDoNothing` rather than a read-then-insert:
 * two clients that both start in an empty room would otherwise both pass the
 * read and the loser would get a constraint error instead of a conflict it can
 * act on.
 */
export async function writeRoomSnapshot(
  db: RoomDatabase,
  params: {
    roomId: string;
    authGeneration: number;
    expectedRevision: number;
    cryptoVersion: number;
    ciphertext: Uint8Array;
    checksum: string;
    userId: string;
    now: Date;
  },
): Promise<SnapshotWriteResult> {
  const byteLength = params.ciphertext.byteLength;
  if (byteLength <= 0 || byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES) {
    throw new Error(
      `Snapshot ciphertext must be 1..${MAX_SNAPSHOT_CIPHERTEXT_BYTES} bytes, received ${byteLength}`,
    );
  }

  const values = {
    roomId: params.roomId,
    authGeneration: params.authGeneration,
    cryptoVersion: params.cryptoVersion,
    ciphertext: params.ciphertext,
    byteLength,
    checksum: params.checksum,
    updatedBy: params.userId,
    updatedAt: params.now,
  };

  if (params.expectedRevision === SNAPSHOT_NO_REVISION) {
    const [created] = await db
      .insert(collaborationSnapshot)
      .values({
        ...values,
        revision: SNAPSHOT_REVISION_START,
        createdAt: params.now,
      })
      .onConflictDoNothing({
        target: [
          collaborationSnapshot.roomId,
          collaborationSnapshot.authGeneration,
        ],
      })
      .returning({ revision: collaborationSnapshot.revision });
    if (!created) {
      const existing = await readRoomSnapshot(db, params);
      return { status: "conflict", currentRevision: existing?.revision };
    }
    await retireOlderGenerations(db, params);
    return { status: "written", revision: created.revision };
  }

  const [updated] = await db
    .update(collaborationSnapshot)
    .set({ ...values, revision: params.expectedRevision + 1 })
    .where(
      and(
        eq(collaborationSnapshot.roomId, params.roomId),
        eq(collaborationSnapshot.authGeneration, params.authGeneration),
        // The predicate is the whole guarantee: a stale writer matches no row.
        eq(collaborationSnapshot.revision, params.expectedRevision),
      ),
    )
    .returning({ revision: collaborationSnapshot.revision });
  if (!updated) {
    const existing = await readRoomSnapshot(db, params);
    return { status: "conflict", currentRevision: existing?.revision };
  }
  await retireOlderGenerations(db, params);
  return { status: "written", revision: updated.revision };
}

/**
 * Deletes the baseline for one room generation, so the room re-seeds from the
 * next writer's canvas. This is the owner's recovery path for a snapshot
 * nobody holding the room's link can open: the server cannot decide
 * unreadability itself — it has no key — so the deletion only ever happens on
 * the owner's explicit, confirmed request. Returns whether a row existed.
 */
export async function deleteRoomSnapshot(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number },
): Promise<boolean> {
  const deleted = await db
    .delete(collaborationSnapshot)
    .where(
      and(
        eq(collaborationSnapshot.roomId, params.roomId),
        eq(collaborationSnapshot.authGeneration, params.authGeneration),
      ),
    )
    .returning({ revision: collaborationSnapshot.revision });
  return deleted.length > 0;
}

/**
 * Drops snapshots of generations this room has moved past. Runs after a
 * successful write rather than on a schedule: the write is the only moment a
 * newer generation is proven to have a usable baseline of its own.
 */
async function retireOlderGenerations(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number },
): Promise<void> {
  await db
    .delete(collaborationSnapshot)
    .where(
      and(
        eq(collaborationSnapshot.roomId, params.roomId),
        lt(collaborationSnapshot.authGeneration, params.authGeneration),
      ),
    );
}
