import "server-only";
import { and, eq, ne } from "drizzle-orm";
import {
  registrationCommandSchema,
  createParentCommandSchema,
  type AdapterCommand,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import {
  collaborationLifecycleRegistration,
  collaborationRoom,
  collaborationCreationFence,
  scene,
} from "@/server/db/schema";
import type { Database, RoomTransaction } from "./rooms";
import { lockRoom, lockRoomId } from "./rooms";
import { AdapterError } from "./authority-storage";
import { lockOrCreateLifecycleSubject } from "./authority-lifecycle-lock";
import { lockActiveAccount } from "./authority-identity";

type Registration = Extract<AdapterCommand, { action: "register" }>;
async function lockSource(
  tx: RoomTransaction,
  subject: string,
  sceneId: string | null,
): Promise<void> {
  if (!sceneId) return;
  const scope = `scene:${sceneId}`;
  const lifecycle = await lockOrCreateLifecycleSubject(tx, {
    scope,
    kind: "scene",
    subject,
    sceneId,
  });
  const [source] = await tx
    .select({ userId: scene.userId })
    .from(scene)
    .where(eq(scene.id, sceneId))
    .for("key share");
  if (
    !lifecycle ||
    lifecycle.frozen ||
    lifecycle.retired ||
    source?.userId !== subject
  )
    throw new AdapterError("fence-mismatch");
}
function checkIdentity(actual: TrustedIdentity, expected: TrustedIdentity) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new AdapterError("fence-mismatch");
}
async function registerSubject(
  tx: RoomTransaction,
  command: Registration,
  identity: TrustedIdentity,
) {
  const [existing] = await tx
    .select()
    .from(collaborationLifecycleRegistration)
    .where(
      and(
        eq(collaborationLifecycleRegistration.subject, identity.subject),
        eq(collaborationLifecycleRegistration.roomId, command.roomId),
      ),
    );
  const owner = command.ownerId === identity.subject;
  if (
    existing &&
    (existing.sceneId !== command.sceneId ||
      (command.create && existing.operationId !== command.operationId))
  )
    throw new AdapterError("operation-mismatch");
  // The caller still locks and validates every live lifecycle before this read.
  // An unchanged registration already participates in retirement enumeration.
  if (
    existing?.lifecycleVersion === identity.lifecycleVersion &&
    (existing.owner || !owner)
  )
    return;
  await tx
    .insert(collaborationLifecycleRegistration)
    .values({
      subject: identity.subject,
      roomId: command.roomId,
      sceneId: command.sceneId,
      owner,
      lifecycleVersion: identity.lifecycleVersion,
      operationId: command.operationId,
    })
    .onConflictDoUpdate({
      target: [
        collaborationLifecycleRegistration.subject,
        collaborationLifecycleRegistration.roomId,
      ],
      set: {
        lifecycleVersion: identity.lifecycleVersion,
        owner: (existing?.owner ?? false) || owner,
      },
    });
}

/**
 * A create may only claim a roomId nobody has used. Room authority deletes its
 * storage once a room ended and settled, so it cannot tell a fresh id from a
 * finished one; this database keeps the ended room row and the creation fence
 * for exactly that. A retry of the same create (same operation) still passes.
 */
async function refuseUsedRoomId(
  tx: RoomTransaction,
  command: Registration,
): Promise<void> {
  const [fence] = await tx
    .select({ ended: collaborationCreationFence.ended })
    .from(collaborationCreationFence)
    .where(eq(collaborationCreationFence.roomId, command.roomId));
  const [room] = await tx
    .select({
      createOperationId: collaborationRoom.createOperationId,
      status: collaborationRoom.status,
      storageState: collaborationRoom.storageState,
    })
    .from(collaborationRoom)
    .where(eq(collaborationRoom.roomId, command.roomId));
  // The fence and the room row are inserted together, so a fence without a
  // room means the room was deleted (scene or account cascade): still used.
  // An ended room is final even for its own create retry: its terminal fence
  // may never have reached storage before Room released its authority.
  if (
    fence?.ended ||
    (fence && !room) ||
    (room &&
      (room.createOperationId !== command.operationId ||
        room.status === "ended" ||
        room.storageState === "ended"))
  )
    throw new AdapterError("fence-mismatch");
  const [claimed] = await tx
    .select({ operationId: collaborationLifecycleRegistration.operationId })
    .from(collaborationLifecycleRegistration)
    .where(
      and(
        eq(collaborationLifecycleRegistration.roomId, command.roomId),
        eq(collaborationLifecycleRegistration.owner, true),
        ne(collaborationLifecycleRegistration.operationId, command.operationId),
      ),
    )
    .limit(1);
  if (claimed) throw new AdapterError("fence-mismatch");
}

/** Conservative registration may contain extra rows, but can never miss a pre-activation subject. */
export async function registerAuthorityCommand(
  db: Database,
  input: Registration,
) {
  const command = registrationCommandSchema.parse(input);
  return db.transaction(async (tx) => {
    const identities = new Map<string, TrustedIdentity>();
    for (const subject of [
      ...new Set([command.identity.subject, command.ownerId]),
    ].sort())
      identities.set(subject, await lockActiveAccount(tx, subject));
    const identity = identities.get(command.identity.subject)!;
    checkIdentity(identity, command.identity);
    if (command.create && command.ownerId !== identity.subject)
      throw new AdapterError("fence-mismatch");
    await lockSource(tx, command.ownerId, command.sceneId);
    // Serialized with fences and cleanup, so no registration lands after an
    // ended room was purged.
    await lockRoomId(tx, command.roomId);
    if (command.create) await refuseUsedRoomId(tx, command);
    else {
      // An ended room keeps no registrations; a late join or upload must not
      // write one back. A missing row is a room still awaiting its parent,
      // unless a terminal fence already ended it.
      const [fence] = await tx
        .select({ ended: collaborationCreationFence.ended })
        .from(collaborationCreationFence)
        .where(eq(collaborationCreationFence.roomId, command.roomId));
      const room = await lockRoom(tx, command.roomId);
      if (
        fence?.ended ||
        (room && (room.status === "ended" || room.storageState === "ended"))
      )
        throw new AdapterError("fence-mismatch");
    }
    await registerSubject(tx, command, identity);
    return {
      roomId: command.roomId,
      operationId: command.operationId,
      subject: identity.subject,
      lifecycleVersion: identity.lifecycleVersion,
    };
  });
}

/** Delivered from the Room's immutable create job, after its authority transaction has committed. */
export async function createAuthorityParent(
  db: Database,
  input: Extract<AdapterCommand, { action: "create-parent" }>,
) {
  const command = createParentCommandSchema.parse(input);
  return db.transaction(async (tx) => {
    const owner = await lockActiveAccount(tx, command.owner.subject);
    checkIdentity(owner, command.owner);
    await lockSource(tx, owner.subject, command.sceneId);
    await lockRoomId(tx, command.roomId);
    const [registered] = await tx
      .select()
      .from(collaborationLifecycleRegistration)
      .where(
        and(
          eq(collaborationLifecycleRegistration.subject, owner.subject),
          eq(collaborationLifecycleRegistration.roomId, command.roomId),
        ),
      );
    if (
      !registered?.owner ||
      registered.operationId !== command.createOperationId ||
      registered.sceneId !== command.sceneId ||
      registered.lifecycleVersion !== owner.lifecycleVersion
    )
      throw new AdapterError("fence-mismatch");
    await tx
      .insert(collaborationCreationFence)
      .values({ roomId: command.roomId })
      .onConflictDoNothing();
    const [creation] = await tx
      .select()
      .from(collaborationCreationFence)
      .where(eq(collaborationCreationFence.roomId, command.roomId))
      .for("update");
    if (creation?.ended) throw new AdapterError("fence-mismatch");
    const receipt = {
      roomId: command.roomId,
      createOperationId: command.createOperationId,
    };
    let room = await lockRoom(tx, command.roomId);
    if (!room) {
      if (command.initializationDeadline <= Date.now())
        throw new AdapterError("initialization-incomplete");
      await tx
        .insert(collaborationRoom)
        .values({
          roomId: command.roomId,
          ownerId: owner.subject,
          sceneId: command.sceneId,
          createOperationId: command.createOperationId,
          label: command.label,
          linkRole: command.linkRole,
          initializationDeadline: new Date(command.initializationDeadline),
        })
        .onConflictDoNothing();
      room = await lockRoom(tx, command.roomId);
    }
    if (
      room?.ownerId !== owner.subject ||
      room.createOperationId !== command.createOperationId ||
      room.sceneId !== command.sceneId
    )
      throw new AdapterError("operation-mismatch");
    return receipt;
  });
}
