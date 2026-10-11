import "server-only";

import {
  and,
  count,
  desc,
  eq,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import type { Database } from "@/server/collab/rooms";
import {
  collaborationAsset,
  collaborationCreationFence,
  collaborationLifecycleRegistration,
  collaborationLifecycleSubject,
  collaborationRoom,
  collaborationRoomInvite,
  collaborationRoomMember,
  collaborationSnapshot,
  fileRecord,
  personalLibrary,
  scene,
  session,
  sharedScene,
} from "@/server/db/schema";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";

const total = (expression: SQL | AnyColumn) =>
  sql<number>`coalesce(sum(${expression}), 0)::bigint`.mapWith(Number);

/**
 * What one account stores and what it has exposed: byte totals per store,
 * live sessions, shared links, published scenes, and its lifecycle record.
 */
export async function readUserFootprint(db: Database, userId: string) {
  const [
    images,
    roomImages,
    sceneDocuments,
    shared,
    library,
    sessions,
    sharedLinks,
    published,
    lifecycle,
  ] = await Promise.all([
    db
      .select({ files: count(), bytes: total(fileRecord.size) })
      .from(fileRecord)
      .where(eq(fileRecord.ownerId, userId)),
    db
      .select({ files: count(), bytes: total(collaborationAsset.byteLength) })
      .from(collaborationAsset)
      .where(eq(collaborationAsset.registeredBy, userId)),
    db
      .select({
        scenes: count(),
        bytes: total(sql`octet_length(${scene.sceneData})`),
      })
      .from(scene)
      .where(eq(scene.userId, userId)),
    db
      .select({
        links: count(),
        bytes: total(sql`octet_length(${sharedScene.compressedData})`),
      })
      .from(sharedScene)
      .where(eq(sharedScene.ownerId, userId)),
    db
      .select({ bytes: personalLibrary.byteLength })
      .from(personalLibrary)
      .where(eq(personalLibrary.userId, userId)),
    db
      .select({ count: count() })
      .from(session)
      .where(eq(session.userId, userId)),
    db
      .select({
        sharedSceneId: sharedScene.sharedSceneId,
        createdAt: sharedScene.createdAt,
        bytes:
          sql<number>`coalesce(octet_length(${sharedScene.compressedData}), 0)`.mapWith(
            Number,
          ),
      })
      .from(sharedScene)
      .where(eq(sharedScene.ownerId, userId))
      .orderBy(desc(sharedScene.createdAt))
      .limit(100),
    db
      .select({
        id: scene.id,
        name: scene.name,
        publishedSlug: scene.publishedSlug,
        publishedAt: scene.publishedAt,
      })
      .from(scene)
      .where(and(eq(scene.userId, userId), eq(scene.isPublished, true)))
      .orderBy(desc(scene.publishedAt))
      .limit(100),
    db.query.collaborationLifecycleSubject.findFirst({
      where: eq(collaborationLifecycleSubject.scope, `account:${userId}`),
    }),
  ]);

  return {
    usage: {
      imageFiles: images[0]?.files ?? 0,
      imageBytes: images[0]?.bytes ?? 0,
      roomImageFiles: roomImages[0]?.files ?? 0,
      roomImageBytes: roomImages[0]?.bytes ?? 0,
      sceneDocumentBytes: sceneDocuments[0]?.bytes ?? 0,
      sharedLinks: shared[0]?.links ?? 0,
      sharedLinkBytes: shared[0]?.bytes ?? 0,
      libraryBytes: library[0]?.bytes ?? 0,
    },
    sessions: sessions[0]?.count ?? 0,
    sharedLinks,
    published,
    lifecycle: lifecycle ?? null,
  };
}

/** Signs an account out everywhere without retiring it. */
export async function revokeUserSessions(db: Database, userId: string) {
  const rows = await db
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return { revoked: rows.length };
}

/**
 * Deletes one shared link before its 30-day expiry, the same way the expiry
 * job does: row locked, its image keys queued for deletion, row deleted.
 */
export async function deleteSharedLink(db: Database, sharedSceneId: string) {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: sharedScene.sharedSceneId })
      .from(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId))
      .for("update");
    if (!row) return { found: false as const };
    const records = await tx
      .select({ key: fileRecord.utFileKey })
      .from(fileRecord)
      .where(eq(fileRecord.sharedSceneId, sharedSceneId));
    const enqueued = await enqueueStorageKeyCleanup(
      tx,
      records.map((record) => record.key),
      "sharedScene_admin_deleted",
      { sharedSceneId },
    );
    await tx
      .delete(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId));
    return { found: true as const, enqueued };
  });
}

const ROOM_ROWS = 100;

/** One room as Neon sees it: row, people, data held, and its fences. */
export async function readRoom(db: Database, roomId: string) {
  const room = await db.query.collaborationRoom.findFirst({
    where: eq(collaborationRoom.roomId, roomId),
  });
  const fence = await db.query.collaborationCreationFence.findFirst({
    where: eq(collaborationCreationFence.roomId, roomId),
  });
  if (!room) return { room: null, fence: fence ?? null };
  const [members, invites, snapshot, assets, registrations] = await Promise.all(
    [
      db
        .select({
          userId: collaborationRoomMember.userId,
          role: collaborationRoomMember.role,
          access: collaborationRoomMember.access,
          revokedAt: collaborationRoomMember.revokedAt,
          lastOpenedAt: collaborationRoomMember.lastOpenedAt,
        })
        .from(collaborationRoomMember)
        .where(eq(collaborationRoomMember.roomId, roomId))
        .orderBy(desc(collaborationRoomMember.listedAt))
        .limit(ROOM_ROWS),
      db
        .select({
          email: collaborationRoomInvite.emailKey,
          role: collaborationRoomInvite.role,
          revokedAt: collaborationRoomInvite.revokedAt,
        })
        .from(collaborationRoomInvite)
        .where(eq(collaborationRoomInvite.roomId, roomId))
        .orderBy(desc(collaborationRoomInvite.listedAt))
        .limit(ROOM_ROWS),
      db
        .select({
          revision: collaborationSnapshot.revision,
          byteLength: collaborationSnapshot.byteLength,
          updatedAt: collaborationSnapshot.updatedAt,
        })
        .from(collaborationSnapshot)
        .where(eq(collaborationSnapshot.roomId, roomId)),
      db
        .select({
          files: count(),
          bytes: total(collaborationAsset.byteLength),
        })
        .from(collaborationAsset)
        .where(eq(collaborationAsset.roomId, roomId)),
      db
        .select({ count: count() })
        .from(collaborationLifecycleRegistration)
        .where(eq(collaborationLifecycleRegistration.roomId, roomId)),
    ],
  );
  return {
    room,
    fence: fence ?? null,
    members,
    invites,
    snapshot: snapshot[0] ?? null,
    assets: assets[0] ?? { files: 0, bytes: 0 },
    registrations: registrations[0]?.count ?? 0,
  };
}
