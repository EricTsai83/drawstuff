import "server-only";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  AUTHORITY_LIMITS,
  lifecycleObjectName,
  type AdapterCommand,
  type LifecycleTarget,
} from "@drawstuff/collaboration/authority";
import {
  collaborationLifecycleSubject as subjects,
  collaborationLifecycleRegistration as registrations,
  scene,
  user,
  session,
} from "@/server/db/schema";
import {
  collectSceneStorageKeys,
  collectUserStorageKeys,
  enqueueStorageKeyCleanup,
} from "@/server/storage/reclaim";
import type { Database, RoomTransaction } from "./rooms";
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
            version: row.version + 1,
            operationId: command.operationId,
          })
          .where(eq(subjects.scope, row.scope));
      if (target.kind === "account")
        await tx.delete(session).where(eq(session.userId, target.subject));
      return { version: row.frozen ? row.version : row.version + 1 };
    }
    if (
      !row.frozen ||
      row.version !== input.version ||
      row.operationId !== command.operationId
    )
      throw new AdapterError("fence-mismatch");
    if (input.action === "lifecycle-list") {
      const rows = await tx
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
            input.cursor ? gt(registrations.roomId, input.cursor) : undefined,
          ),
        )
        .orderBy(asc(registrations.roomId))
        .limit(AUTHORITY_LIMITS.alarmBatch + 1);
      const page = rows.slice(0, AUTHORITY_LIMITS.alarmBatch);
      return {
        version: row.version,
        rooms: page.map((room) => ({
          roomId: room.roomId,
          action: room.owner ? "end-room" : "revoke-member",
        })),
        cursor: rows.length > page.length ? page.at(-1)!.roomId : null,
      };
    }
    if (!row.retired) {
      // Only Lifecycle calls this after every registered Room's terminal storage fence ACK.
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
