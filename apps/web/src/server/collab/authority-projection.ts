import "server-only";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  emailKeySchema,
  inviteProjectionEventSchema,
  projectionEventSchema,
  roomListInputSchema,
  subjectSchema,
  type InviteProjectionEvent,
  type ProjectionEvent,
  type RoomAccess,
} from "@drawstuff/collaboration/authority";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";
import {
  collaborationLifecycleSubject,
  collaborationProjectionTombstone,
  collaborationRoom,
  collaborationRoomInvite,
  collaborationRoomMember,
  user,
} from "@/server/db/schema";
import {
  lockRoom,
  type Database,
  type RoomRecord,
  type RoomTransaction,
} from "./rooms";

/** Both projection kinds carry the room's display fields; the newest version wins. */
async function syncRoomDisplay(
  tx: RoomTransaction,
  room: RoomRecord,
  event: Pick<ProjectionEvent, "version" | "label" | "status">,
  now: Date,
): Promise<void> {
  if (event.version <= room.projectionVersion) return;
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
    .where(eq(collaborationRoom.roomId, room.roomId));
}

/** Display copies only. Do not use these rows or this function to grant room access. */
export async function applyRoomProjection(
  db: Database,
  input: ProjectionEvent,
) {
  const event = projectionEventSchema.parse(input);
  return db.transaction(async (tx) => {
    // Match retirement's account fence → user → Room lock order.
    await tx
      .select()
      .from(collaborationLifecycleSubject)
      .where(
        eq(collaborationLifecycleSubject.scope, `account:${event.subject}`),
      )
      .for("update");
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
    const room = await lockRoom(tx, event.roomId);
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
    const live = {
      role: negativeEvent ? null : event.role,
      access: negativeEvent ? null : event.access,
      revokedAt: negativeEvent ? now : null,
      projectionVersion: event.version,
    };
    await tx
      .insert(collaborationRoomMember)
      .values({
        roomId: event.roomId,
        userId: event.subject,
        ...live,
        listedAt: new Date(event.listedAt),
      })
      .onConflictDoUpdate({
        target: [
          collaborationRoomMember.roomId,
          collaborationRoomMember.userId,
        ],
        set: { ...live, updatedAt: now },
      });
    await syncRoomDisplay(tx, room, event, now);
    return { applied: true };
  });
}

/**
 * Email-keyed invitation rows, so an invitation shows up before it is opened.
 * Display copies only. A missing room drops the event: rooms are never deleted
 * while live, and an ended room keeps its row.
 */
export async function applyInviteProjection(
  db: Database,
  input: InviteProjectionEvent,
) {
  const event = inviteProjectionEventSchema.parse(input);
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, event.roomId);
    if (!room) return { applied: false };
    const [existing] = await tx
      .select({ version: collaborationRoomInvite.projectionVersion })
      .from(collaborationRoomInvite)
      .where(
        and(
          eq(collaborationRoomInvite.roomId, event.roomId),
          eq(collaborationRoomInvite.emailKey, event.email),
        ),
      );
    if (
      (existing && existing.version >= event.version) ||
      (room.status === "ended" && event.status !== "ended")
    )
      return { applied: false };
    const now = new Date();
    const negative = event.tombstone || event.status === "ended";
    const live = {
      role: negative ? null : event.role,
      revokedAt: negative ? now : null,
      projectionVersion: event.version,
      updatedAt: now,
    };
    await tx
      .insert(collaborationRoomInvite)
      .values({
        roomId: event.roomId,
        emailKey: event.email,
        ...live,
        listedAt: new Date(event.listedAt),
      })
      .onConflictDoUpdate({
        target: [
          collaborationRoomInvite.roomId,
          collaborationRoomInvite.emailKey,
        ],
        set: live,
      });
    await syncRoomDisplay(tx, room, event, now);
    return { applied: true };
  });
}

type ListedRoom = {
  roomId: string;
  label: string;
  sceneId: string | null;
  status: string;
  role: RoomRole;
  access: RoomAccess;
  listedAt: number;
};

const newestFirst = (a: ListedRoom, b: ListedRoom) =>
  b.listedAt - a.listedAt || (a.roomId < b.roomId ? 1 : -1);

/**
 * One section of the room list (plan 21 §5), as a stable descending
 * (listedAt, roomId) keyset. `mine` merges the account's owned/invited rows
 * with invitations to its email it has not opened yet; `link` holds rooms
 * opened through general access only. Display copies, never authorization.
 */
export async function listProjectedRooms(
  db: Database,
  account: { subject: string; email: string | null },
  input: unknown = {},
) {
  subjectSchema.parse(account.subject);
  const { section, cursor, limit } = roomListInputSchema.parse(input);
  const [lifecycle] = await db
    .select({
      frozen: collaborationLifecycleSubject.frozen,
      retired: collaborationLifecycleSubject.retired,
    })
    .from(collaborationLifecycleSubject)
    .where(
      eq(collaborationLifecycleSubject.scope, `account:${account.subject}`),
    );
  if (lifecycle?.frozen || lifecycle?.retired)
    return { rooms: [], nextCursor: null };
  const liveRoom = or(
    eq(collaborationRoom.status, "initializing"),
    eq(collaborationRoom.status, "ready"),
  );
  const after = (
    listedAt:
      | typeof collaborationRoomMember.listedAt
      | typeof collaborationRoomInvite.listedAt,
  ) =>
    cursor
      ? or(
          lt(listedAt, new Date(cursor.listedAt)),
          and(
            eq(listedAt, new Date(cursor.listedAt)),
            lt(collaborationRoom.roomId, cursor.roomId),
          ),
        )
      : undefined;
  const members = await db
    .select({
      roomId: collaborationRoom.roomId,
      label: collaborationRoom.label,
      sceneId: collaborationRoom.sceneId,
      status: collaborationRoom.status,
      role: collaborationRoomMember.role,
      access: collaborationRoomMember.access,
      listedAt: collaborationRoomMember.listedAt,
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
    .where(
      and(
        eq(collaborationRoomMember.userId, account.subject),
        isNull(collaborationRoomMember.revokedAt),
        inArray(
          collaborationRoomMember.access,
          section === "mine" ? ["owned", "invited"] : ["link"],
        ),
        or(
          isNull(collaborationProjectionTombstone.version),
          lt(
            collaborationProjectionTombstone.version,
            collaborationRoomMember.projectionVersion,
          ),
        ),
        liveRoom,
        after(collaborationRoomMember.listedAt),
      ),
    )
    .orderBy(
      desc(collaborationRoomMember.listedAt),
      desc(collaborationRoom.roomId),
    )
    .limit(limit + 1);
  const email = account.email ? emailKeySchema.safeParse(account.email) : null;
  const invites =
    section === "mine" && email?.success
      ? await db
          .select({
            roomId: collaborationRoom.roomId,
            label: collaborationRoom.label,
            sceneId: collaborationRoom.sceneId,
            status: collaborationRoom.status,
            role: collaborationRoomInvite.role,
            listedAt: collaborationRoomInvite.listedAt,
          })
          .from(collaborationRoomInvite)
          .innerJoin(
            collaborationRoom,
            eq(collaborationRoom.roomId, collaborationRoomInvite.roomId),
          )
          .where(
            and(
              eq(collaborationRoomInvite.emailKey, email.data),
              isNull(collaborationRoomInvite.revokedAt),
              // An opened invitation is listed once, from the account's own row.
              sql`not exists (select 1 from ${collaborationRoomMember} where ${collaborationRoomMember.roomId} = ${collaborationRoomInvite.roomId} and ${collaborationRoomMember.userId} = ${account.subject} and ${collaborationRoomMember.revokedAt} is null)`,
              liveRoom,
              after(collaborationRoomInvite.listedAt),
            ),
          )
          .orderBy(
            desc(collaborationRoomInvite.listedAt),
            desc(collaborationRoom.roomId),
          )
          .limit(limit + 1)
      : [];
  const listed = new Map<string, ListedRoom>();
  for (const row of members)
    if (row.role && row.access)
      listed.set(row.roomId, {
        ...row,
        role: row.role as RoomRole,
        access: row.access as RoomAccess,
        listedAt: row.listedAt.getTime(),
      });
  for (const row of invites)
    if (row.role && !listed.has(row.roomId))
      listed.set(row.roomId, {
        ...row,
        role: row.role as RoomRole,
        access: "invited",
        listedAt: row.listedAt.getTime(),
      });
  const rows = [...listed.values()].sort(newestFirst);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rooms: page,
    nextCursor:
      rows.length > limit && last
        ? { listedAt: last.listedAt, roomId: last.roomId }
        : null,
  };
}
