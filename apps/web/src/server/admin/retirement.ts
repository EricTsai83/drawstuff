import "server-only";

import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import {
  dispatchControlOutboxEvent,
  enqueueRoomControlEvent,
  type ControlOutboxEvent,
} from "@/server/collab/control-outbox";
import {
  bumpRoomAuthRevision,
  listActiveRoomMemberIds,
  lockRoom,
  type Database,
} from "@/server/collab/rooms";
import { collaborationRoom, scene, user } from "@/server/db/schema";
import {
  collectSceneStorageKeys,
  collectUserStorageKeys,
  enqueueStorageKeyCleanup,
} from "@/server/storage/reclaim";

/**
 * Deletes a scene and everything it owns. Row deletion and the storage-key
 * enqueue commit in one transaction; the maintenance drain deletes the
 * objects afterwards. Deleting storage first (the old order) could crash
 * mid-loop and leave a live scene row pointing at objects that no longer
 * exist — the reverse leaves at worst an already-queued key.
 */
export async function retireScene(params: {
  db: Database;
  sceneId: string;
  /** When set, only this owner may retire the scene; anyone else is refused. */
  ownerUserId?: string;
}) {
  return await params.db.transaction(async (tx) => {
    // The scene row lock serializes with save-time validation and asset
    // cleanup, which take the same lock before touching file records.
    const [target] = await tx
      .select({ id: scene.id, userId: scene.userId })
      .from(scene)
      .where(eq(scene.id, params.sceneId))
      .for("update");
    if (!target) return { found: false as const, enqueuedObjects: 0 };
    if (params.ownerUserId && target.userId !== params.ownerUserId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the scene owner can perform this action.",
      });
    }
    const keys = await collectSceneStorageKeys(tx, [params.sceneId]);
    const enqueuedObjects = await enqueueStorageKeyCleanup(
      tx,
      keys,
      "delete-scene",
      { sceneId: params.sceneId },
    );
    await tx.delete(scene).where(eq(scene.id, params.sceneId));
    return { found: true as const, enqueuedObjects };
  });
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
    // Ending an already-ended room still enqueues: the delivery is
    // revision-max idempotent, and a retried end must be able to close
    // sockets an earlier, undelivered event did not reach.
    const authRevision =
      room.status === "ended"
        ? room.authRevision
        : await bumpRoomAuthRevision(tx, room, now);
    if (room.status !== "ended") {
      await tx
        .update(collaborationRoom)
        .set({ status: "ended", endedAt: now, updatedAt: now })
        .where(eq(collaborationRoom.roomId, room.roomId));
    }
    const outboxEvent = await enqueueRoomControlEvent(tx, {
      roomId: room.roomId,
      authGeneration: room.authGeneration,
      authRevision,
      action: "end-room",
      now,
    });
    return { outboxEvent, memberCount };
  });
  if (!ended) return { found: false as const, enforcement: "pending" as const };
  const control = await dispatchControlOutboxEvent(
    params.db,
    ended.outboxEvent,
    now,
  );
  return {
    found: true as const,
    memberCount: ended.memberCount,
    enforcement: control.enforced
      ? ("enforced" as const)
      : ("pending" as const),
  };
}

/**
 * Deletes an account and everything it owns in one bounded transaction:
 * every storage key the user's data holds goes into the cleanup outbox and
 * the user row's cascade removes all dependent rows. No per-scene or
 * per-object round trips — the old shape issued one storage call per object
 * and one transaction per room, so a large account timed out half-retired.
 *
 * Durable Object shutdown for rooms that were still active is enqueued to the
 * durable control outbox in the same transaction (the room rows are gone
 * after it, so the outbox row is the only surviving enforcement intent),
 * then dispatched best-effort after the commit; whatever fails is drained by
 * the cron. `authRevision + 1` is the cutoff a lifecycle bump would have
 * produced.
 */
export async function retireAccount(params: { db: Database; userId: string }) {
  const retired = await params.db.transaction(async (tx) => {
    // The user row lock blocks anything new being created under this account
    // (scenes, shared scenes, rooms all take the user's FOREIGN KEY) while the
    // keys are collected and the cascade runs.
    const [target] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, params.userId))
      .for("update");
    if (!target) return null;
    const ownedScenes = await tx
      .select({ id: scene.id })
      .from(scene)
      .where(eq(scene.userId, params.userId));
    // The collector takes every remaining lock in the shared deletion order
    // (shared scene → scene → room); the room rows are therefore already
    // locked when they are read below, which also serializes with join-token
    // issuance — no token can be minted from a room this transaction is about
    // to delete.
    const keys = await collectUserStorageKeys(tx, params.userId);
    const now = new Date();
    const rooms = await tx
      .select({
        roomId: collaborationRoom.roomId,
        status: collaborationRoom.status,
        authGeneration: collaborationRoom.authGeneration,
        authRevision: collaborationRoom.authRevision,
      })
      .from(collaborationRoom)
      .where(eq(collaborationRoom.ownerId, params.userId))
      .orderBy(collaborationRoom.roomId)
      .for("update");
    const outboxEvents: ControlOutboxEvent[] = [];
    for (const room of rooms) {
      if (room.status !== "active") continue;
      outboxEvents.push(
        await enqueueRoomControlEvent(tx, {
          roomId: room.roomId,
          authGeneration: room.authGeneration,
          authRevision: room.authRevision + 1,
          action: "end-room",
          now,
        }),
      );
    }
    const enqueuedObjects = await enqueueStorageKeyCleanup(
      tx,
      keys,
      "delete-user",
      { userId: params.userId },
    );
    await tx.delete(user).where(eq(user.id, params.userId));
    return {
      rooms: rooms.length,
      outboxEvents,
      scenes: ownedScenes.length,
      enqueuedObjects,
    };
  });
  if (!retired) {
    return {
      found: false as const,
      scenes: 0,
      rooms: 0,
      enqueuedObjects: 0,
      enforcedRooms: 0,
    };
  }

  // Bounded parallelism: each push can wait out the provider's 3s timeout,
  // so a serial loop over many rooms could run for minutes after the commit.
  let enforcedRooms = 0;
  const CONTROL_PUSH_BATCH = 5;
  const events = retired.outboxEvents;
  for (let start = 0; start < events.length; start += CONTROL_PUSH_BATCH) {
    const results = await Promise.all(
      events
        .slice(start, start + CONTROL_PUSH_BATCH)
        .map((event) => dispatchControlOutboxEvent(params.db, event)),
    );
    enforcedRooms += results.filter((result) => result.enforced).length;
  }
  return {
    found: true as const,
    scenes: retired.scenes,
    rooms: retired.rooms,
    enqueuedObjects: retired.enqueuedObjects,
    enforcedRooms,
  };
}
