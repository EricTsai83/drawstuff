import "server-only";

import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { UTApi } from "uploadthing/server";

import { pushRelayRoomControl } from "@/server/collab/relay-control";
import {
  bumpRoomAuthRevision,
  listActiveRoomMemberIds,
  lockRoom,
  type Database,
} from "@/server/collab/rooms";
import {
  collaborationRoom,
  deferredFileCleanup,
  fileRecord,
  scene,
  user,
} from "@/server/db/schema";

type StorageDelete = (key: string) => Promise<void>;

const defaultStorageDelete: StorageDelete = async (key) => {
  await new UTApi().deleteFiles([key]);
};

async function deleteOrEnqueue(
  db: Database,
  deleteStorageFile: StorageDelete,
  key: string,
  reason: "delete-scene" | "delete-user",
  context: Record<string, string>,
): Promise<"deleted" | "enqueued"> {
  try {
    await deleteStorageFile(key);
    return "deleted";
  } catch (error) {
    await db.insert(deferredFileCleanup).values({
      utFileKey: key,
      reason,
      context: JSON.stringify(context),
      lastError: String(error),
    });
    return "enqueued";
  }
}

export async function retireScene(params: {
  db: Database;
  sceneId: string;
  deleteStorageFile?: StorageDelete;
}) {
  const target = await params.db.query.scene.findFirst({
    where: eq(scene.id, params.sceneId),
    columns: { id: true, thumbnailFileKey: true },
  });
  if (!target) return { found: false, deletedObjects: 0, enqueuedObjects: 0 };

  const records = await params.db
    .select({ key: fileRecord.utFileKey })
    .from(fileRecord)
    .where(eq(fileRecord.sceneId, params.sceneId));
  const keys = new Set(records.map(({ key }) => key));
  if (target.thumbnailFileKey) keys.add(target.thumbnailFileKey);

  let deletedObjects = 0;
  let enqueuedObjects = 0;
  for (const key of keys) {
    const result = await deleteOrEnqueue(
      params.db,
      params.deleteStorageFile ?? defaultStorageDelete,
      key,
      "delete-scene",
      { sceneId: params.sceneId },
    );
    if (result === "deleted") deletedObjects += 1;
    else enqueuedObjects += 1;
  }
  await params.db.delete(scene).where(eq(scene.id, params.sceneId));
  return { found: true, deletedObjects, enqueuedObjects };
}

export async function endRoom(params: {
  db: Database;
  roomId: string;
  ownerUserId?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const ended = await params.db.transaction(async (tx) => {
    await lockRoom(tx, params.roomId);
    const room = await tx.query.collaborationRoom.findFirst({
      where: eq(collaborationRoom.roomId, params.roomId),
    });
    if (!room) return null;
    if (params.ownerUserId && room.ownerId !== params.ownerUserId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the room owner can perform this action.",
      });
    }
    const memberCount = (await listActiveRoomMemberIds(tx, room.roomId)).length;
    if (room.status === "ended")
      return { room, authRevision: room.authRevision, memberCount };
    await tx
      .update(collaborationRoom)
      .set({ status: "ended", endedAt: now, updatedAt: now })
      .where(eq(collaborationRoom.roomId, room.roomId));
    return {
      room,
      authRevision: await bumpRoomAuthRevision(tx, room, now),
      memberCount,
    };
  });
  if (!ended) return { found: false, relayEnforced: false };
  const relay = await pushRelayRoomControl({
    action: "end-room",
    roomId: ended.room.roomId,
    authGeneration: ended.room.authGeneration,
    authRevision: ended.authRevision,
    now,
  });
  return {
    found: true,
    memberCount: ended.memberCount,
    relayEnforced: relay.enforced,
  };
}

export async function retireAccount(params: {
  db: Database;
  userId: string;
  deleteStorageFile?: StorageDelete;
}) {
  const target = await params.db.query.user.findFirst({
    where: eq(user.id, params.userId),
    columns: { id: true },
  });
  if (!target) return { found: false, scenes: 0, rooms: 0 };

  const ownedScenes = await params.db
    .select({ id: scene.id })
    .from(scene)
    .where(eq(scene.userId, params.userId));
  const sceneIds = ownedScenes.map(({ id }) => id);
  const rooms = await params.db
    .select({ id: collaborationRoom.roomId })
    .from(collaborationRoom)
    .where(eq(collaborationRoom.ownerId, params.userId));
  for (const room of rooms) await endRoom({ db: params.db, roomId: room.id });
  for (const ownedScene of ownedScenes) {
    await retireScene({
      db: params.db,
      sceneId: ownedScene.id,
      deleteStorageFile: params.deleteStorageFile,
    });
  }

  // Shared-scene objects are owner-scoped but not necessarily attached to an owned scene.
  const remainingRecords = await params.db
    .select({ key: fileRecord.utFileKey })
    .from(fileRecord)
    .where(eq(fileRecord.ownerId, params.userId));
  for (const { key } of remainingRecords) {
    await deleteOrEnqueue(
      params.db,
      params.deleteStorageFile ?? defaultStorageDelete,
      key,
      "delete-user",
      { userId: params.userId },
    );
  }
  await params.db.delete(user).where(eq(user.id, params.userId));
  return { found: true, scenes: sceneIds.length, rooms: rooms.length };
}
