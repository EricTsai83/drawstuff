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
  collaborationLifecycleRegistration,
  collaborationLifecycleSubject,
  collaborationOperation,
  collaborationProjectionTombstone,
  collaborationRoom,
  collaborationRoomInvite,
  collaborationRoomMember,
  user,
} from "@/server/db/schema";
import {
  lockRoom,
  lockRoomId,
  type Database,
  type RoomRecord,
  type RoomTransaction,
} from "./rooms";

/**
 * An ended room is never listed, so its list rows only hold personal data
 * (who was in it, invited emails, its name). Every path that sees the room
 * end removes them: projections here, the adapter's cleanup, and the
 * retention backstop (`purgeEndedRoomRecords`).
 */
const endedLabel = "";
/** Either signal is final; the terminal fence may arrive before the ended projection. */
const roomEnded = (room: RoomRecord) =>
  room.status === "ended" || room.storageState === "ended";

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
      label: event.status === "ended" ? endedLabel : event.label,
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
    // A deleted room (owner or scene removed) takes its rows with it; nothing
    // to record for a delayed event.
    if (!room) return { applied: false };
    const whereMember = and(
      eq(collaborationRoomMember.roomId, event.roomId),
      eq(collaborationRoomMember.userId, event.subject),
    );
    if (roomEnded(room) || event.status === "ended") {
      await tx.delete(collaborationRoomMember).where(whereMember);
      await tx
        .delete(collaborationProjectionTombstone)
        .where(
          and(
            eq(collaborationProjectionTombstone.roomId, event.roomId),
            eq(collaborationProjectionTombstone.subject, event.subject),
          ),
        );
      if (roomEnded(room)) return { applied: false };
      await syncRoomDisplay(tx, room, event, new Date());
      return { applied: true };
    }
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
    const negativeEvent = event.tombstone;
    if (
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
    const [member] = await tx
      .select()
      .from(collaborationRoomMember)
      .where(whereMember);
    if (member && member.projectionVersion >= event.version)
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
 * Display copies only. A missing room drops the event, and an ended room
 * keeps no invitation rows.
 */
export async function applyInviteProjection(
  db: Database,
  input: InviteProjectionEvent,
) {
  const event = inviteProjectionEventSchema.parse(input);
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, event.roomId);
    if (!room) return { applied: false };
    const whereInvite = and(
      eq(collaborationRoomInvite.roomId, event.roomId),
      eq(collaborationRoomInvite.emailKey, event.email),
    );
    if (roomEnded(room) || event.status === "ended") {
      await tx.delete(collaborationRoomInvite).where(whereInvite);
      if (roomEnded(room)) return { applied: false };
      await syncRoomDisplay(tx, room, event, new Date());
      return { applied: true };
    }
    const [existing] = await tx
      .select({ version: collaborationRoomInvite.projectionVersion })
      .from(collaborationRoomInvite)
      .where(whereInvite);
    if (existing && existing.version >= event.version)
      return { applied: false };
    const now = new Date();
    const live = {
      role: event.tombstone ? null : event.role,
      revokedAt: event.tombstone ? now : null,
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
 * One section of the room list (docs/architecture/collaboration-authority.md), as a stable descending
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
  const email = account.email ? emailKeySchema.safeParse(account.email) : null;
  const emailKey = email?.success ? email.data : null;
  // A room has two list rows for an invited account: its own (subject) row
  // and the email-keyed invitation row. They arrive independently, so the
  // newer one decides whether and where the room is listed; on a tie (one
  // command projected both) the account's own row wins.
  const memberIsCurrent = emailKey
    ? sql`not exists (select 1 from ${collaborationRoomInvite} where ${collaborationRoomInvite.roomId} = ${collaborationRoomMember.roomId} and ${collaborationRoomInvite.emailKey} = ${emailKey} and ${collaborationRoomInvite.projectionVersion} > ${collaborationRoomMember.projectionVersion})`
    : undefined;
  const inviteIsCurrent = sql`not exists (select 1 from ${collaborationRoomMember} where ${collaborationRoomMember.roomId} = ${collaborationRoomInvite.roomId} and ${collaborationRoomMember.userId} = ${account.subject} and ${collaborationRoomMember.projectionVersion} >= ${collaborationRoomInvite.projectionVersion})`;
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
        memberIsCurrent,
        liveRoom,
        after(collaborationRoomMember.listedAt),
      ),
    )
    .orderBy(
      desc(collaborationRoomMember.listedAt),
      desc(collaborationRoom.roomId),
    )
    .limit(limit + 1);
  const invites =
    section === "mine" && emailKey
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
              eq(collaborationRoomInvite.emailKey, emailKey),
              isNull(collaborationRoomInvite.revokedAt),
              inviteIsCurrent,
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

/**
 * Removes every per-person record of an ended room — list rows, projection
 * tombstones, content receipts, lifecycle registrations — and its name. Only
 * the room row (status `ended`) and its creation fence remain, which is what
 * refuses the roomId's reuse. Returns how many records were removed.
 */
export async function purgeEndedRoomRecords(
  tx: RoomTransaction,
  roomId: string,
): Promise<number> {
  // Room locks before deleting children, in the shared order, so concurrent
  // projections and registrations wait instead of deadlocking.
  await lockRoomId(tx, roomId);
  await lockRoom(tx, roomId);
  // Sequential: one transaction connection.
  const removed = [
    await tx
      .delete(collaborationRoomMember)
      .where(eq(collaborationRoomMember.roomId, roomId))
      .returning({ id: collaborationRoomMember.id }),
    await tx
      .delete(collaborationRoomInvite)
      .where(eq(collaborationRoomInvite.roomId, roomId))
      .returning({ id: collaborationRoomInvite.emailKey }),
    await tx
      .delete(collaborationProjectionTombstone)
      .where(eq(collaborationProjectionTombstone.roomId, roomId))
      .returning({ id: collaborationProjectionTombstone.subject }),
    await tx
      .delete(collaborationOperation)
      .where(eq(collaborationOperation.roomId, roomId))
      .returning({ id: collaborationOperation.operationId }),
    await tx
      .delete(collaborationLifecycleRegistration)
      .where(eq(collaborationLifecycleRegistration.roomId, roomId))
      .returning({ id: collaborationLifecycleRegistration.subject }),
  ];
  await tx
    .update(collaborationRoom)
    .set({ label: endedLabel })
    .where(eq(collaborationRoom.roomId, roomId));
  return removed.reduce((total, rows) => total + rows.length, 0);
}
