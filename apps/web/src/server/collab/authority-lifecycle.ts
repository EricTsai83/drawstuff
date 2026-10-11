import "server-only";
import { and, asc, eq, isNull, sql, type AnyColumn } from "drizzle-orm";
import {
  AUTHORITY_LIMITS,
  lifecycleObjectName,
  normalizeAccountEmail,
  type AdapterCommand,
  type LifecycleTarget,
} from "@drawstuff/collaboration/authority";
import {
  collaborationLifecycleSubject as subjects,
  collaborationLifecycleRegistration as registrations,
  collaborationProjectionTombstone,
  collaborationRoom,
  collaborationRoomInvite,
  scene,
  user,
  session,
} from "@/server/db/schema";
import { purgeEndedRoomRecords } from "./authority-projection";
import {
  collectSceneStorageKeys,
  collectUserStorageKeys,
  enqueueStorageKeyCleanup,
} from "@/server/storage/reclaim";
import { lockRoomId, type Database, type RoomTransaction } from "./rooms";
import { AdapterError } from "./authority-storage";

type Command = Extract<
  AdapterCommand,
  { action: "lifecycle-freeze" | "lifecycle-list" | "lifecycle-delete" }
>;
async function lockTarget(tx: RoomTransaction, input: Command) {
  const target = input.command.target;
  // Registration locks accounts first, then the source. Match that order for scene retirement.
  if (target.kind === "scene") {
    await tx
      .insert(subjects)
      .values({
        scope: `account:${target.subject}`,
        kind: "account",
        subject: target.subject,
      })
      .onConflictDoNothing();
    await tx
      .select()
      .from(subjects)
      .where(eq(subjects.scope, `account:${target.subject}`))
      .for("update");
  }
  const scope = lifecycleObjectName(target);
  await tx
    .insert(subjects)
    .values({
      scope,
      kind: target.kind,
      subject: target.subject,
      sceneId: target.kind === "scene" ? target.sceneId : null,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(subjects)
    .where(eq(subjects.scope, scope))
    .for("update");
  if (
    row?.subject !== target.subject ||
    (row.operationId !== null && row.operationId !== input.command.operationId)
  )
    throw new AdapterError("operation-mismatch");
  return row;
}
/**
 * Room-ID order and cursor comparison in the C collation, so pages from two
 * sources merge exactly regardless of the database's default collation.
 */
const byRoom = (column: AnyColumn) => sql`${column} collate "C"`;
const afterRoom = (column: AnyColumn, cursor: string) =>
  sql`${column} collate "C" > ${cursor}`;

/** The account's normalized email while its row exists; undefined after. */
async function accountEmailKey(
  tx: RoomTransaction,
  userId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  if (!row) return undefined;
  try {
    return normalizeAccountEmail(row.email);
  } catch {
    // An address the collaboration contract cannot carry was never invited.
    return undefined;
  }
}

export async function applyLifecycleAdapter(db: Database, input: Command) {
  return db.transaction(async (tx) => {
    const row = await lockTarget(tx, input);
    const command = input.command;
    const target = command.target;
    if (input.action === "lifecycle-freeze") {
      if (!row.frozen)
        await tx
          .update(subjects)
          .set({
            frozen: true,
            frozenAt: new Date(),
            version: row.version + 1,
            operationId: command.operationId,
          })
          .where(eq(subjects.scope, row.scope));
      if (target.kind === "account")
        await tx.delete(session).where(eq(session.userId, target.subject));
      const version = row.frozen ? row.version : row.version + 1;
      // The account's email lets Lifecycle withdraw its invitations from
      // rooms it never joined (no registration points there).
      const email =
        target.kind === "account"
          ? await accountEmailKey(tx, target.subject)
          : undefined;
      // Accounts always carry the field: `null` says "no usable email",
      // which Lifecycle tells apart from an older build that omits it.
      return target.kind === "account"
        ? { version, email: email ?? null }
        : { version };
    }
    if (
      !row.frozen ||
      row.version !== input.version ||
      row.operationId !== command.operationId
    )
      throw new AdapterError("fence-mismatch");
    if (input.action === "lifecycle-list") {
      const batch = AUTHORITY_LIMITS.alarmBatch;
      const registered = await tx
        .select()
        .from(registrations)
        .where(
          and(
            target.kind === "account"
              ? eq(registrations.subject, target.subject)
              : and(
                  eq(registrations.sceneId, target.sceneId),
                  eq(registrations.owner, true),
                ),
            input.cursor
              ? afterRoom(registrations.roomId, input.cursor)
              : undefined,
          ),
        )
        .orderBy(byRoom(registrations.roomId))
        .limit(batch + 1);
      // An account is also on the invitation lists of rooms it never opened.
      const email =
        target.kind === "account"
          ? await accountEmailKey(tx, target.subject)
          : undefined;
      const invited =
        email === undefined
          ? []
          : await tx
              .select({ roomId: collaborationRoomInvite.roomId })
              .from(collaborationRoomInvite)
              .where(
                and(
                  eq(collaborationRoomInvite.emailKey, email),
                  isNull(collaborationRoomInvite.revokedAt),
                  input.cursor
                    ? afterRoom(collaborationRoomInvite.roomId, input.cursor)
                    : undefined,
                ),
              )
              .orderBy(byRoom(collaborationRoomInvite.roomId))
              .limit(batch + 1);
      // Both sources hold `batch + 1` rows past the cursor, so the first
      // `batch` of their sorted union is exactly this page.
      const actions = new Map<string, "end-room" | "revoke-member">();
      for (const room of invited) actions.set(room.roomId, "revoke-member");
      for (const room of registered)
        actions.set(room.roomId, room.owner ? "end-room" : "revoke-member");
      // Binary order on both sides: the SQL pages above sort and compare with
      // the C collation, which matches this code-point sort for room IDs.
      const merged = [...actions.keys()].sort();
      const page = merged.slice(0, batch);
      return {
        version: row.version,
        rooms: page.map((roomId) => ({ roomId, action: actions.get(roomId)! })),
        cursor: merged.length > page.length ? page.at(-1)! : null,
      };
    }
    if (!row.retired) {
      // Only Lifecycle calls this after every registered Room's terminal storage fence ACK.
      // Rooms about to cascade away first drop their records that have no
      // room foreign key (registrations, projection tombstones). Their roomId
      // locks come before any room row lock (shared order), sorted, after
      // the account or scene row lock.
      if (target.kind === "account")
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, target.subject))
          .for("update");
      else
        await tx
          .select({ id: scene.id })
          .from(scene)
          .where(eq(scene.id, target.sceneId))
          .for("update");
      const cascading = await tx
        .select({ roomId: collaborationRoom.roomId })
        .from(collaborationRoom)
        .where(
          target.kind === "account"
            ? eq(collaborationRoom.ownerId, target.subject)
            : eq(collaborationRoom.sceneId, target.sceneId),
        )
        .orderBy(asc(collaborationRoom.roomId));
      for (const { roomId } of cascading) await lockRoomId(tx, roomId);
      for (const { roomId } of cascading)
        await purgeEndedRoomRecords(tx, roomId);
      if (target.kind === "account") {
        // The account's own traces in other people's rooms.
        await tx
          .delete(registrations)
          .where(eq(registrations.subject, target.subject));
        await tx
          .delete(collaborationProjectionTombstone)
          .where(eq(collaborationProjectionTombstone.subject, target.subject));
      }
      if (target.kind === "account") {
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, target.subject))
          .for("update");
        const keys = await collectUserStorageKeys(tx, target.subject);
        await enqueueStorageKeyCleanup(tx, keys, "delete-user", {
          userId: target.subject,
        });
        await tx.delete(user).where(eq(user.id, target.subject));
      } else {
        const [source] = await tx
          .select({ userId: scene.userId })
          .from(scene)
          .where(eq(scene.id, target.sceneId))
          .for("update");
        if (source && source.userId !== target.subject)
          throw new AdapterError("fence-mismatch");
        const keys = await collectSceneStorageKeys(tx, [target.sceneId]);
        await enqueueStorageKeyCleanup(tx, keys, "delete-scene", {
          sceneId: target.sceneId,
        });
        await tx.delete(scene).where(eq(scene.id, target.sceneId));
      }
      await tx
        .update(subjects)
        .set({ retired: true })
        .where(eq(subjects.scope, row.scope));
    }
    return { deleted: true as const };
  });
}
/** All entry points recover the immutable command from this durable DB intent. */
export async function retirementIntent(
  db: Database,
  target: LifecycleTarget,
  _actor: string,
) {
  return db.transaction(async (tx) => {
    const scope = lifecycleObjectName(target);
    await tx
      .insert(subjects)
      .values({
        scope,
        kind: target.kind,
        subject: target.subject,
        sceneId: target.kind === "scene" ? target.sceneId : null,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(subjects)
      .where(eq(subjects.scope, scope))
      .for("update");
    if (row?.subject !== target.subject)
      throw new AdapterError("fence-mismatch");
    const operationId = row.operationId ?? crypto.randomUUID();
    if (!row.operationId)
      await tx
        .update(subjects)
        .set({ operationId })
        .where(eq(subjects.scope, scope));
    // actor is an audit field; keep it deterministic when a different authorized entry resumes retirement.
    return { v: 1 as const, operationId, actor: target.subject, target };
  });
}
