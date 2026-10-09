import "server-only";
import { eq, sql } from "drizzle-orm";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { db as database } from "@/server/db";
import { collaborationRoom } from "@/server/db/schema";
export type Database = typeof database;
export type RoomTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type RoomRecord = typeof collaborationRoom.$inferSelect;
export const roomIdInputSchema = roomIdSchema;
/**
 * Serializes everything that decides whether a roomId may still gain records
 * — registration, parent creation, storage fences, cleanup and purges — even
 * before a room row exists. Lock order: account and scene locks, then this,
 * then the room row (`lockRoom`). Re-acquiring it in one transaction is free.
 */
export async function lockRoomId(
  tx: RoomTransaction,
  roomId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"drawstuff:collab-room:" + roomId},0))`,
  );
}

/** A storage/projection lock, never an authorization lookup. */
export async function lockRoom(
  tx: RoomTransaction,
  roomId: string,
): Promise<RoomRecord | undefined> {
  const [room] = await tx
    .select()
    .from(collaborationRoom)
    .where(eq(collaborationRoom.roomId, roomId))
    .for("update");
  return room;
}
