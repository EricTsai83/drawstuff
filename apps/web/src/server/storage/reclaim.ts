import "server-only";

import { eq, inArray } from "drizzle-orm";

import type { db as database } from "@/server/db";
import {
  collaborationAsset,
  collaborationRoom,
  deferredFileCleanup,
  fileRecord,
  scene,
  sharedScene,
} from "@/server/db/schema";

type Database = typeof database;
type DatabaseExecutor =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Storage keys that deleting the given scenes would orphan: their asset
 * records, their thumbnails, and the assets of collaboration rooms bound to
 * them (scene deletion cascades collaboration_room → collaboration_asset).
 *
 * Callers collect inside the same transaction that deletes the rows and hand
 * the keys to {@link enqueueStorageKeyCleanup}: once the rows are gone the
 * queue row is the only durable pointer to the object — the GC sweeps only
 * scenes that still exist.
 *
 * Every parent row is locked FOR UPDATE before its keys are read. Writers
 * that add keys either take the same lock explicitly (asset uploads lock the
 * room row, thumbnail replacement updates the scene row) or implicitly need
 * the parent's FOR KEY SHARE for their foreign key (file-record inserts), and
 * both conflict with FOR UPDATE — so no new key can slip in between this read
 * and the cascade that deletes its row.
 *
 * Lock order is fixed across every deletion path — user, shared scene, scene,
 * then room, each set ordered by id — and asset uploads take the uploader's
 * user row before the room row, so overlapping deletions and uploads queue
 * instead of deadlocking.
 */
export async function collectSceneStorageKeys(
  db: DatabaseExecutor,
  sceneIds: string[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (sceneIds.length === 0) return keys;

  const thumbnails = await db
    .select({ key: scene.thumbnailFileKey })
    .from(scene)
    .where(inArray(scene.id, sceneIds))
    .orderBy(scene.id)
    .for("update");
  for (const { key } of thumbnails) if (key) keys.add(key);

  await db
    .select({ id: collaborationRoom.roomId })
    .from(collaborationRoom)
    .where(inArray(collaborationRoom.sceneId, sceneIds))
    .orderBy(collaborationRoom.roomId)
    .for("update");

  const records = await db
    .select({ key: fileRecord.utFileKey })
    .from(fileRecord)
    .where(inArray(fileRecord.sceneId, sceneIds));
  for (const { key } of records) keys.add(key);

  const roomAssets = await db
    .select({ key: collaborationAsset.utFileKey })
    .from(collaborationAsset)
    .innerJoin(
      collaborationRoom,
      eq(collaborationAsset.roomId, collaborationRoom.roomId),
    )
    .where(inArray(collaborationRoom.sceneId, sceneIds));
  for (const { key } of roomAssets) keys.add(key);

  return keys;
}

/**
 * Storage keys that deleting the user would orphan: everything their scenes
 * hold, owner-scoped records not attached to an owned scene (shared-scene
 * uploads), and the assets of rooms they own.
 */
export async function collectUserStorageKeys(
  db: DatabaseExecutor,
  userId: string,
): Promise<Set<string>> {
  // Locked parents (see collectSceneStorageKeys): shared scenes serialize
  // their file-record inserts, owned rooms serialize asset uploads. Shared
  // scenes lock before scenes, rooms after — the shared deletion lock order.
  await db
    .select({ id: sharedScene.sharedSceneId })
    .from(sharedScene)
    .where(eq(sharedScene.ownerId, userId))
    .orderBy(sharedScene.sharedSceneId)
    .for("update");

  const ownedScenes = await db
    .select({ id: scene.id })
    .from(scene)
    .where(eq(scene.userId, userId));
  const keys = await collectSceneStorageKeys(
    db,
    ownedScenes.map(({ id }) => id),
  );

  await db
    .select({ id: collaborationRoom.roomId })
    .from(collaborationRoom)
    .where(eq(collaborationRoom.ownerId, userId))
    .orderBy(collaborationRoom.roomId)
    .for("update");

  const ownerRecords = await db
    .select({ key: fileRecord.utFileKey })
    .from(fileRecord)
    .where(eq(fileRecord.ownerId, userId));
  for (const { key } of ownerRecords) keys.add(key);

  const ownedRoomAssets = await db
    .select({ key: collaborationAsset.utFileKey })
    .from(collaborationAsset)
    .innerJoin(
      collaborationRoom,
      eq(collaborationAsset.roomId, collaborationRoom.roomId),
    )
    .where(eq(collaborationRoom.ownerId, userId));
  for (const { key } of ownedRoomAssets) keys.add(key);

  return keys;
}

/**
 * Inserts the keys into the deferred-cleanup outbox, inside the caller's
 * delete transaction. The maintenance queue drain deletes the objects; the
 * caller never touches storage directly, so a crash between commit and any
 * storage call can no longer strand an object without a pointer.
 */
/** Rows per INSERT: each row binds several parameters (defaults are computed
 * client-side), and one unchunked statement for a many-thousand-object account
 * would exceed PostgreSQL's bind-parameter limit and fail the whole delete. */
const ENQUEUE_CHUNK_SIZE = 500;

export async function enqueueStorageKeyCleanup(
  db: DatabaseExecutor,
  keys: Iterable<string>,
  reason: string,
  context: Record<string, unknown>,
  now?: Date,
): Promise<number> {
  const values = [...new Set(keys)].map((utFileKey) => ({
    utFileKey,
    reason,
    context: JSON.stringify(context),
    ...(now
      ? { attempts: 0, nextAttemptAt: now, status: "pending" as const }
      : {}),
  }));
  for (let start = 0; start < values.length; start += ENQUEUE_CHUNK_SIZE) {
    await db
      .insert(deferredFileCleanup)
      .values(values.slice(start, start + ENQUEUE_CHUNK_SIZE));
  }
  return values.length;
}
