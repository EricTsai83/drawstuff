import "server-only";

import { and, asc, eq, inArray, lt } from "drizzle-orm";

import {
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ROOM_ASSETS_PER_GENERATION,
  type CollaborationAssetRecord,
  type ExcalidrawAssetId,
} from "@drawstuff/collaboration/asset";
import { roomRoleCanEditScene } from "@drawstuff/collaboration/room-auth";

import {
  collaborationAsset,
  deferredFileCleanup,
  user,
} from "@/server/db/schema";
import {
  lockRoom,
  resolveRoomAccess,
  type Database,
  type RoomDatabase,
} from "@/server/collab/rooms";

/**
 * Where a room generation's encrypted assets live.
 *
 * The store's job is identity plus a pointer. It records that a room generation
 * has the ciphertext for a file id and where that ciphertext currently is, and it
 * refuses to let one asset displace another — which is the property the old
 * content-hash identity got wrong. Two images with identical bytes but different
 * file ids are two assets here, and the same image uploaded twice is one.
 *
 * Nothing in this module can read an asset: the bytes are sealed in the browser
 * under a key derived from the room key (`@drawstuff/collaboration/asset`), which
 * never reaches the backend. What the server holds is a URL and a length.
 */

/** One row as a client may see it: identity plus where the ciphertext is. */
export type RoomAssetRecord = CollaborationAssetRecord;

export type AssetStorageInput = {
  cryptoVersion: number;
  utFileKey: string;
  url: string;
  byteLength: number;
};

type AssetRecordResult =
  /** The row is now this upload's; nothing else referenced this file id. */
  | { status: "recorded" }
  /**
   * The generation already had this file id, and the row was left alone. The
   * bytes under it are equally valid — an asset's plaintext is fixed by its id —
   * so the caller's job is to delete the object it just uploaded, not to retry.
   */
  | { status: "duplicate"; utFileKey: string }
  | {
      status: "budget-exceeded";
      current: number;
      limit: number;
    };

/** Ascending file ids one generation has ciphertext for, or `[]` when it has none. */
async function listRoomAssetIds(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number },
): Promise<ExcalidrawAssetId[]> {
  const rows = await db
    .select({ excalidrawFileId: collaborationAsset.excalidrawFileId })
    .from(collaborationAsset)
    .where(
      and(
        eq(collaborationAsset.roomId, params.roomId),
        eq(collaborationAsset.authGeneration, params.authGeneration),
      ),
    )
    .orderBy(asc(collaborationAsset.excalidrawFileId));
  return rows.map((row) => row.excalidrawFileId);
}

/**
 * Resolves a bounded batch of file ids to their download records.
 *
 * Only the ids the caller asked for, and only the current generation's: an asset
 * sealed under a retired generation could not be opened by anybody, so pointing a
 * client at it would only produce a decryption failure it cannot act on.
 */
export async function resolveRoomAssets(
  db: RoomDatabase,
  params: {
    roomId: string;
    authGeneration: number;
    fileIds: readonly ExcalidrawAssetId[];
  },
): Promise<RoomAssetRecord[]> {
  if (params.fileIds.length === 0) return [];
  const rows = await db
    .select({
      excalidrawFileId: collaborationAsset.excalidrawFileId,
      cryptoVersion: collaborationAsset.cryptoVersion,
      byteLength: collaborationAsset.byteLength,
      url: collaborationAsset.url,
    })
    .from(collaborationAsset)
    .where(
      and(
        eq(collaborationAsset.roomId, params.roomId),
        eq(collaborationAsset.authGeneration, params.authGeneration),
        inArray(collaborationAsset.excalidrawFileId, [...params.fileIds]),
      ),
    )
    .orderBy(asc(collaborationAsset.excalidrawFileId));
  return rows;
}

/**
 * Records one uploaded asset.
 *
 * `onConflictDoNothing` rather than read-then-insert: two peers that both paste
 * the same image race here by design, and the loser must get "duplicate" rather
 * than a constraint error — the asset it wanted exists, which is the outcome. The
 * distinction only matters because the loser owns an orphan storage object it has
 * to delete.
 *
 * The budget is checked inside the caller's transaction against the count that is
 * actually committed, so concurrent uploads cannot each observe room under the
 * limit and jointly exceed it.
 */
async function recordRoomAsset(
  db: RoomDatabase,
  params: {
    roomId: string;
    authGeneration: number;
    fileId: ExcalidrawAssetId;
    storage: AssetStorageInput;
    userId: string;
    now: Date;
  },
): Promise<AssetRecordResult> {
  const { byteLength } = params.storage;
  if (byteLength <= 0 || byteLength > MAX_ASSET_CIPHERTEXT_BYTES) {
    throw new Error(
      `Asset ciphertext must be 1..${MAX_ASSET_CIPHERTEXT_BYTES} bytes, received ${byteLength}`,
    );
  }

  const existing = await listRoomAssetIds(db, params);
  const alreadyPresent = existing.includes(params.fileId);
  if (!alreadyPresent && existing.length >= MAX_ROOM_ASSETS_PER_GENERATION) {
    return {
      status: "budget-exceeded",
      current: existing.length,
      limit: MAX_ROOM_ASSETS_PER_GENERATION,
    };
  }

  const [inserted] = await db
    .insert(collaborationAsset)
    .values({
      roomId: params.roomId,
      authGeneration: params.authGeneration,
      excalidrawFileId: params.fileId,
      cryptoVersion: params.storage.cryptoVersion,
      utFileKey: params.storage.utFileKey,
      url: params.storage.url,
      byteLength,
      registeredBy: params.userId,
      createdAt: params.now,
    })
    .onConflictDoNothing({
      target: [
        collaborationAsset.roomId,
        collaborationAsset.authGeneration,
        collaborationAsset.excalidrawFileId,
      ],
    })
    .returning({ utFileKey: collaborationAsset.utFileKey });

  if (!inserted) {
    return { status: "duplicate", utFileKey: params.storage.utFileKey };
  }
  return { status: "recorded" };
}

/**
 * What happened to one completed upload. Only `recorded` leaves the storage
 * object referenced; every other outcome means the caller owns an orphan it has
 * to delete.
 */
export type AssetUploadOutcome =
  | "recorded"
  | "duplicate"
  | "budget-exceeded"
  /** Access, role, or generation changed between the upload and this write. */
  | "rejected";

/**
 * Commits one completed upload: authorization and the write in a single
 * transaction under the room lock.
 *
 * The authorization check the upload route already made is not enough, and the
 * gap is real rather than theoretical: an upload takes as long as the bytes take,
 * and a membership revocation, a role downgrade, or a generation rotation can
 * commit while it is in flight. Re-checking here — inside the lock, in the same
 * transaction as the insert, the ordering every room lifecycle mutation uses
 * — is what makes "was allowed when it started" mean "is allowed now".
 *
 * The generation check is the sharpest of the three: the ciphertext is sealed
 * against a specific generation, so filing it under any other one would produce a
 * row nobody could ever open.
 */
export async function commitRoomAssetUpload(
  db: Database,
  params: {
    roomId: string;
    userId: string;
    authGeneration: number;
    fileId: ExcalidrawAssetId;
    storage: AssetStorageInput;
    now: Date;
  },
): Promise<AssetUploadOutcome> {
  return db.transaction(async (tx) => {
    // Uploader's user row before the room row: account retirement locks the
    // user FOR UPDATE and then the rooms, and the `registered_by` insert
    // below needs this row's FOR KEY SHARE — taking it first keeps every
    // user/room acquisition in the same order, so an upload racing the
    // uploader's own retirement queues instead of deadlocking.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, params.userId))
      .for("key share");
    await lockRoom(tx, params.roomId);
    const access = await resolveRoomAccess(tx, {
      roomId: params.roomId,
      userId: params.userId,
      now: params.now,
    });
    if (
      access.status !== "ok" ||
      // A viewer receives assets but never adds one. The relay refuses its
      // realtime mutations; this refuses the durable equivalent.
      !roomRoleCanEditScene(access.role) ||
      access.room.authGeneration !== params.authGeneration
    ) {
      return "rejected";
    }

    const result = await recordRoomAsset(tx, {
      roomId: params.roomId,
      authGeneration: params.authGeneration,
      fileId: params.fileId,
      storage: params.storage,
      userId: params.userId,
      now: params.now,
    });
    if (result.status !== "recorded") return result.status;

    // The only moment a newer generation is proven to have an asset of its own is
    // the moment one lands, which is why retirement runs here rather than on a
    // schedule.
    await retireOlderAssetGenerations(tx, {
      roomId: params.roomId,
      authGeneration: params.authGeneration,
      now: params.now,
    });
    return "recorded";
  });
}

/** Reason recorded on cleanup tasks this module schedules. */
export const RETIRED_ASSET_CLEANUP_REASON = "collab-asset-generation-retired";

/**
 * Drops assets of generations the room has moved past, on the same trigger and
 * for the same reason as snapshot retirement: a rotated generation's asset
 * payloads are sealed under a key nobody can derive any more, so keeping them
 * would only be storage nobody can ever open.
 *
 * Deleting a row is what makes its storage object unreachable, so the same
 * statement that deletes it hands the object to the deferred cleanup worker — in
 * the caller's transaction, which is the only way the two cannot diverge. The
 * object store cannot participate in that transaction, which is precisely why the
 * queue exists rather than a direct delete here.
 */
async function retireOlderAssetGenerations(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number; now: Date },
): Promise<{ retiredObjects: number }> {
  const retired = await db
    .delete(collaborationAsset)
    .where(
      and(
        eq(collaborationAsset.roomId, params.roomId),
        lt(collaborationAsset.authGeneration, params.authGeneration),
      ),
    )
    .returning({
      utFileKey: collaborationAsset.utFileKey,
      authGeneration: collaborationAsset.authGeneration,
    });
  if (retired.length === 0) return { retiredObjects: 0 };

  await db.insert(deferredFileCleanup).values(
    retired.map((row) => ({
      utFileKey: row.utFileKey,
      reason: RETIRED_ASSET_CLEANUP_REASON,
      context: JSON.stringify({
        roomId: params.roomId,
        retiredGeneration: row.authGeneration,
        currentGeneration: params.authGeneration,
      }),
      attempts: 0,
      nextAttemptAt: params.now,
      status: "pending" as const,
    })),
  );
  return { retiredObjects: retired.length };
}
