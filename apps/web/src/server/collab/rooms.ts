import "server-only";
import { eq } from "drizzle-orm";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { db as database } from "@/server/db";
import { collaborationRoom } from "@/server/db/schema";
export type Database = typeof database;
export type RoomTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type RoomRecord = typeof collaborationRoom.$inferSelect;
export const roomIdInputSchema = roomIdSchema;
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
