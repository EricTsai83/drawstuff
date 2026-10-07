import "server-only";

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  projectionEventSchema,
  roomListInputSchema,
  subjectSchema,
  type ProjectionEvent,
} from "@drawstuff/collaboration/authority";
import {
  collaborationLifecycleSubject,
  collaborationProjectionTombstone,
  collaborationRoom,
  collaborationRoomMember,
  user,
} from "@/server/db/schema";
import { lockRoom, type Database } from "./rooms";

/** Display copies only. Do not use these rows or this function to grant room access. */
export async function applyRoomProjection(
  db: Database,
  input: ProjectionEvent,
) {
  const event = projectionEventSchema.parse(input);
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, event.roomId);
    const [account] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, event.subject))
      .for("key share");
    const [lifecycle] = await tx
      .select()
      .from(collaborationLifecycleSubject)
      .where(
        eq(collaborationLifecycleSubject.scope, `account:${event.subject}`),
      );
    const [negative] = await tx
      .select()
      .from(collaborationProjectionTombstone)
      .where(
        and(
          eq(collaborationProjectionTombstone.roomId, event.roomId),
          eq(collaborationProjectionTombstone.subject, event.subject),
        ),
      );
    if (negative && negative.version >= event.version)
      return { applied: false };
    const negativeEvent = event.tombstone || event.status === "ended";
    if (
      !room ||
      !account ||
      ((lifecycle?.frozen || lifecycle?.retired) && !negativeEvent)
    ) {
      await tx
        .insert(collaborationProjectionTombstone)
        .values({
          roomId: event.roomId,
          subject: event.subject,
          version: event.version,
        })
        .onConflictDoUpdate({
          target: [
            collaborationProjectionTombstone.roomId,
            collaborationProjectionTombstone.subject,
          ],
          set: {
            version: sql`greatest(${collaborationProjectionTombstone.version}, ${event.version})`,
          },
        });
      return { applied: false };
    }
    const whereMember = and(
      eq(collaborationRoomMember.roomId, event.roomId),
      eq(collaborationRoomMember.userId, event.subject),
    );
    const [member] = await tx
      .select()
      .from(collaborationRoomMember)
      .where(whereMember);
    if (
      (member && member.projectionVersion >= event.version) ||
      (room.status === "ended" && event.status !== "ended")
    )
      return { applied: false };
    const now = new Date();
    if (negativeEvent)
      await tx
        .insert(collaborationProjectionTombstone)
        .values({
          roomId: event.roomId,
          subject: event.subject,
          version: event.version,
        })
        .onConflictDoUpdate({
          target: [
            collaborationProjectionTombstone.roomId,
            collaborationProjectionTombstone.subject,
          ],
          set: { version: event.version },
        });
    await tx
      .insert(collaborationRoomMember)
      .values({
        roomId: event.roomId,
        userId: event.subject,
        role: event.role,
        revokedAt: negativeEvent ? now : null,
        projectionVersion: event.version,
        listedAt: new Date(event.listedAt),
      })
      .onConflictDoUpdate({
        target: [
          collaborationRoomMember.roomId,
          collaborationRoomMember.userId,
        ],
        set: {
          role: event.role,
          revokedAt: negativeEvent ? now : null,
          projectionVersion: event.version,
          updatedAt: now,
        },
      });
    if (event.version > room.projectionVersion) {
      await tx
        .update(collaborationRoom)
        .set({
          projectionVersion: event.version,
          authRevision: Math.max(room.authRevision, event.version),
          label: event.label,
          status: event.status,
          endedAt: event.status === "ended" ? (room.endedAt ?? now) : null,
          updatedAt: now,
        })
        .where(eq(collaborationRoom.roomId, event.roomId));
    }
    return { applied: true };
  });
}

/** Stable descending (listedAt, roomId) keyset; independent rooms have no scene join. */
export async function listProjectedRooms(
  db: Database,
  subject: string,
  input: unknown = {},
) {
  subjectSchema.parse(subject);
  const { cursor, limit } = roomListInputSchema.parse(input);
  const rows = await db
    .select({
      roomId: collaborationRoom.roomId,
      label: collaborationRoom.label,
      sceneId: collaborationRoom.sceneId,
      status: collaborationRoom.status,
      role: collaborationRoomMember.role,
      listedAt: collaborationRoomMember.listedAt,
      projectionVersion: collaborationRoomMember.projectionVersion,
    })
    .from(collaborationRoomMember)
    .innerJoin(
      collaborationRoom,
      eq(collaborationRoom.roomId, collaborationRoomMember.roomId),
    )
    .leftJoin(
      collaborationProjectionTombstone,
      and(
        eq(
          collaborationProjectionTombstone.roomId,
          collaborationRoomMember.roomId,
        ),
        eq(
          collaborationProjectionTombstone.subject,
          collaborationRoomMember.userId,
        ),
      ),
    )
    .leftJoin(
      collaborationLifecycleSubject,
      eq(collaborationLifecycleSubject.scope, `account:${subject}`),
    )
    .where(
      and(
        eq(collaborationRoomMember.userId, subject),
        isNull(collaborationRoomMember.revokedAt),
        or(
          isNull(collaborationProjectionTombstone.version),
          lt(
            collaborationProjectionTombstone.version,
            collaborationRoomMember.projectionVersion,
          ),
        ),
        or(
          isNull(collaborationLifecycleSubject.scope),
          and(
            eq(collaborationLifecycleSubject.frozen, false),
            eq(collaborationLifecycleSubject.retired, false),
          ),
        ),
        or(
          eq(collaborationRoom.status, "initializing"),
          eq(collaborationRoom.status, "ready"),
        ),
        cursor
          ? or(
              lt(collaborationRoomMember.listedAt, new Date(cursor.listedAt)),
              and(
                eq(collaborationRoomMember.listedAt, new Date(cursor.listedAt)),
                lt(collaborationRoom.roomId, cursor.roomId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(collaborationRoomMember.listedAt),
      desc(collaborationRoom.roomId),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rooms: page.map((row) => ({ ...row, listedAt: row.listedAt.getTime() })),
    nextCursor:
      rows.length > limit && last
        ? { listedAt: last.listedAt.getTime(), roomId: last.roomId }
        : null,
  };
}
