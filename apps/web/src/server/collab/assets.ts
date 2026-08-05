import "server-only";

import { and, asc, eq, lt } from "drizzle-orm";

import {
  MAX_ROOM_ASSETS_PER_GENERATION,
  type ExcalidrawAssetId,
} from "@drawstuff/collaboration/asset";

import { collaborationAsset } from "@/server/db/schema";
import type { RoomDatabase } from "@/server/collab/rooms";

/**
 * The room's asset manifest: which Excalidraw file ids one generation claims.
 *
 * The store's whole job is identity. It records that a room generation
 * references a file id, and it refuses to let one registration displace
 * another — which is the property the old content-hash identity got wrong. Two
 * images with identical bytes but different file ids are two assets here, and
 * the same image registered twice is one.
 *
 * Nothing in this module reads or writes bytes; Plan 17 adds the transfer.
 */

export type AssetRegistrationResult = {
  /** Ids that this call inserted. */
  registered: ExcalidrawAssetId[];
  /** Ids the generation already referenced; a retry lands entirely here. */
  alreadyPresent: ExcalidrawAssetId[];
  /** The generation's full manifest after the call, ascending. */
  fileIds: ExcalidrawAssetId[];
};

/** Ascending file ids one generation references, or `[]` when it has none. */
export async function listRoomAssets(
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

export type AssetBudgetError = {
  code: "asset-budget-exceeded";
  current: number;
  requested: number;
  limit: number;
};

/**
 * Registers asset ids for one generation.
 *
 * `onConflictDoNothing` rather than read-then-insert: two peers that both see a
 * newly pasted image race here by design, and the loser must get "already
 * present" rather than a constraint error — an asset that exists is exactly the
 * outcome it wanted. What comes back distinguishes the two cases only so the
 * caller can report them; both are success.
 *
 * The budget is checked inside the caller's transaction against the count that
 * is actually committed, so concurrent registrations cannot each observe room
 * under the limit and jointly exceed it.
 */
export async function registerRoomAssets(
  db: RoomDatabase,
  params: {
    roomId: string;
    authGeneration: number;
    fileIds: readonly ExcalidrawAssetId[];
    userId: string;
    now: Date;
  },
): Promise<AssetRegistrationResult | AssetBudgetError> {
  const existing = new Set(await listRoomAssets(db, params));
  const fresh = params.fileIds.filter((fileId) => !existing.has(fileId));
  if (existing.size + fresh.length > MAX_ROOM_ASSETS_PER_GENERATION) {
    return {
      code: "asset-budget-exceeded",
      current: existing.size,
      requested: fresh.length,
      limit: MAX_ROOM_ASSETS_PER_GENERATION,
    };
  }

  if (fresh.length > 0) {
    await db
      .insert(collaborationAsset)
      .values(
        fresh.map((fileId) => ({
          roomId: params.roomId,
          authGeneration: params.authGeneration,
          excalidrawFileId: fileId,
          registeredBy: params.userId,
          createdAt: params.now,
        })),
      )
      .onConflictDoNothing({
        target: [
          collaborationAsset.roomId,
          collaborationAsset.authGeneration,
          collaborationAsset.excalidrawFileId,
        ],
      });
    await retireOlderGenerations(db, params);
  }

  return {
    registered: fresh,
    alreadyPresent: params.fileIds.filter((fileId) => existing.has(fileId)),
    fileIds: await listRoomAssets(db, params),
  };
}

/**
 * Drops manifests of generations the room has moved past, on the same trigger
 * and for the same reason as snapshot retirement: a rotated generation's asset
 * payloads are sealed under a key nobody can derive any more, so its manifest
 * can only ever point at bytes that cannot be opened.
 */
async function retireOlderGenerations(
  db: RoomDatabase,
  params: { roomId: string; authGeneration: number },
): Promise<void> {
  await db
    .delete(collaborationAsset)
    .where(
      and(
        eq(collaborationAsset.roomId, params.roomId),
        lt(collaborationAsset.authGeneration, params.authGeneration),
      ),
    );
}
