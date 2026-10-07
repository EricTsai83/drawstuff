import "server-only";

import { createHash } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  adapterCommandSchema,
  AUTHORITY_LIMITS,
  contentOperationSchema,
  contentResultSchema,
  type AdapterCommand,
  type ContentOperation,
  type ContentResult,
} from "@drawstuff/collaboration/authority";
import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
  SNAPSHOT_CRYPTO_VERSION,
} from "@drawstuff/collaboration/snapshot";
import { MAX_ROOM_ASSETS_PER_GENERATION } from "@drawstuff/collaboration/asset";
import {
  collaborationAsset,
  collaborationOperation,
  collaborationRoom,
  collaborationCreationFence,
  collaborationSnapshot,
  deferredFileCleanup,
} from "@/server/db/schema";
import { lockRoom, type Database, type RoomTransaction } from "./rooms";

type OperationRow = typeof collaborationOperation.$inferSelect;
type RoomRow = typeof collaborationRoom.$inferSelect;
type StorageContext = {
  roomId: string;
  authGeneration: number;
  authorityEpoch: number;
};
export class AdapterError extends Error {
  constructor(
    readonly code:
      | "operation-mismatch"
      | "invalid-body"
      | "body-too-large"
      | "fence-mismatch"
      | "not-found"
      | "capacity"
      | "initialization-incomplete",
  ) {
    super(code);
  }
}
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const fingerprint = (operation: ContentOperation): string =>
  digest(JSON.stringify(contentOperationSchema.parse(operation)));
const snapshotWhere = (context: StorageContext) =>
  and(
    eq(collaborationSnapshot.roomId, context.roomId),
    eq(collaborationSnapshot.authGeneration, context.authGeneration),
  );
const assetWhere = (context: StorageContext) =>
  and(
    eq(collaborationAsset.roomId, context.roomId),
    eq(collaborationAsset.authGeneration, context.authGeneration),
  );

function replay(row: OperationRow, operation: ContentOperation): ContentResult {
  if (row.requestFingerprint !== fingerprint(operation))
    throw new AdapterError("operation-mismatch");
  return contentResultSchema.parse({
    status: row.status,
    ...(row.status === "written" ? { revision: row.revision } : {}),
  });
}
function matches(room: RoomRow, context: StorageContext): boolean {
  return (
    room.storageState !== "ended" &&
    room.authorityEpoch === context.authorityEpoch &&
    room.storageGeneration === context.authGeneration
  );
}

/** One transaction per accepted intent. All fences, writes and cancellations acquire this same room lock. */
export async function executeStorageOperation(
  db: Database,
  action: "write" | "query" | "cancel",
  input: ContentOperation,
  bytes?: Uint8Array,
): Promise<ContentResult> {
  const operation = contentOperationSchema.parse(input);
  if (action === "write") {
    if (operation.kind === "snapshot-put") {
      if (
        !bytes ||
        bytes.byteLength < MIN_SNAPSHOT_SEALED_BYTES ||
        bytes[0] !== SNAPSHOT_CRYPTO_VERSION
      )
        throw new AdapterError("invalid-body");
      if (bytes.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES)
        throw new AdapterError("body-too-large");
      if (digest(bytes) !== operation.checksum)
        throw new AdapterError("invalid-body");
    } else if (
      bytes?.byteLength ||
      (operation.kind === "snapshot-reset" &&
        operation.checksum !== digest(new Uint8Array()))
    )
      throw new AdapterError("invalid-body");
  }
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, operation.roomId);
    const [previous] = await tx
      .select()
      .from(collaborationOperation)
      .where(eq(collaborationOperation.operationId, operation.operationId));
    if (previous) {
      const result = replay(previous, operation);
      if (result.status !== "pending" || action === "query") return result;
    }
    if (!room) return { status: "refused" };
    if (action === "query") return { status: "pending" };
    // Only terminal receipts are eligible for bounded retention. Missing bytes never create a pending DB receipt.
    const expired = await tx
      .select({ id: collaborationOperation.operationId })
      .from(collaborationOperation)
      .where(
        and(
          eq(collaborationOperation.roomId, operation.roomId),
          lt(
            collaborationOperation.terminalAt,
            new Date(Date.now() - AUTHORITY_LIMITS.resultRetentionMs),
          ),
        ),
      )
      .limit(AUTHORITY_LIMITS.alarmBatch);
    if (expired.length)
      await tx.delete(collaborationOperation).where(
        inArray(
          collaborationOperation.operationId,
          expired.map((row) => row.id),
        ),
      );
    // Claim global operation identity before effects, including races across different rooms.
    const [claimed] = previous
      ? [previous]
      : await tx
          .insert(collaborationOperation)
          .values({
            operationId: operation.operationId,
            roomId: operation.roomId,
            actor: operation.actor.subject,
            kind: operation.kind,
            authorityEpoch: operation.authorityEpoch,
            authGeneration: operation.authGeneration,
            expectedRevision: operation.expectedRevision,
            checksum: operation.checksum,
            requestFingerprint: fingerprint(operation),
            assetId: operation.asset?.excalidrawFileId,
            utFileKey: operation.asset?.utFileKey,
            deadline: new Date(operation.deadline),
            status: "pending",
          })
          .onConflictDoNothing()
          .returning();
    if (!claimed) {
      const [winner] = await tx
        .select()
        .from(collaborationOperation)
        .where(eq(collaborationOperation.operationId, operation.operationId));
      if (!winner) throw new AdapterError("operation-mismatch");
      return replay(winner, operation);
    }
    let result: ContentResult;
    const now = Date.now();
    if (action === "cancel") result = { status: "cancelled" };
    else if (
      !matches(room, operation) ||
      operation.deadline <= now ||
      operation.deadline > now + AUTHORITY_LIMITS.operationTtlMs ||
      (room.storageState === "initializing" &&
        (room.ownerId !== operation.actor.subject ||
          room.initializationDeadline.getTime() <= now)) ||
      (operation.kind === "snapshot-reset" &&
        room.ownerId !== operation.actor.subject)
    )
      result = { status: "refused" };
    else if (operation.kind === "asset-finalize")
      result = await finalizeAsset(tx, operation);
    else {
      const [snapshot] = await tx
        .select()
        .from(collaborationSnapshot)
        .where(snapshotWhere(operation));
      const current = Math.max(room.snapshotRevision, snapshot?.revision ?? 0);
      if (current !== operation.expectedRevision)
        result = { status: "conflict" };
      else {
        const revision = current + 1;
        if (operation.kind === "snapshot-reset")
          await tx
            .delete(collaborationSnapshot)
            .where(snapshotWhere(operation));
        else {
          if (!bytes) throw new AdapterError("invalid-body");
          const values = {
            roomId: operation.roomId,
            authGeneration: operation.authGeneration,
            revision,
            cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
            ciphertext: bytes,
            byteLength: bytes.byteLength,
            checksum: operation.checksum,
            updatedBy: operation.actor.subject,
            updatedAt: new Date(),
          };
          await tx
            .insert(collaborationSnapshot)
            .values(values)
            .onConflictDoUpdate({
              target: [
                collaborationSnapshot.roomId,
                collaborationSnapshot.authGeneration,
              ],
              set: values,
            });
        }
        await tx
          .update(collaborationRoom)
          .set({
            snapshotRevision: revision,
            ...(room.storageState === "initializing"
              ? {
                  initializationRevision: null,
                  initializationChecksum: null,
                  initializationAssetIds: [],
                }
              : {}),
          })
          .where(eq(collaborationRoom.roomId, operation.roomId));
        result = { status: "written", revision };
      }
    }
    await tx
      .update(collaborationOperation)
      .set({
        status: result.status,
        revision: result.status === "written" ? result.revision : null,
        terminalAt: new Date(),
      })
      .where(eq(collaborationOperation.operationId, operation.operationId));
    if (operation.asset && result.status !== "written")
      await queueOrphan(tx, operation.asset.utFileKey, operation.roomId);
    return result;
  });
}

/** Provider object keys come only from the trusted upload-finalization path, never a browser role assertion. */
async function finalizeAsset(
  tx: RoomTransaction,
  operation: ContentOperation,
): Promise<ContentResult> {
  const asset = operation.asset;
  if (!asset) throw new AdapterError("invalid-body");
  await lockAssetObject(tx, asset.utFileKey);
  const rows = await tx
    .select()
    .from(collaborationAsset)
    .where(assetWhere(operation));
  const old = rows.find(
    (row) => row.excalidrawFileId === asset.excalidrawFileId,
  );
  if (old) {
    if (old.utFileKey !== asset.utFileKey) {
      await queueOrphan(tx, asset.utFileKey, operation.roomId);
      return { status: "written", revision: 1 };
    }
    if (
      old.url !== asset.url ||
      old.cryptoVersion !== asset.cryptoVersion ||
      old.byteLength !== asset.byteLength
    )
      throw new AdapterError("operation-mismatch");
    return { status: "written", revision: 1 };
  }
  if (rows.length >= MAX_ROOM_ASSETS_PER_GENERATION)
    return { status: "refused" };
  const [referenced] = await tx
    .select({ key: collaborationAsset.utFileKey })
    .from(collaborationAsset)
    .where(eq(collaborationAsset.utFileKey, asset.utFileKey))
    .limit(1);
  if (referenced) return { status: "refused" };
  // Cleanup and a new reference must never race for the same provider object identity.
  const [cleanup] = await tx
    .select({ id: deferredFileCleanup.id })
    .from(deferredFileCleanup)
    .where(eq(deferredFileCleanup.utFileKey, asset.utFileKey))
    .limit(1);
  if (cleanup) return { status: "refused" };
  await tx.insert(collaborationAsset).values({
    roomId: operation.roomId,
    authGeneration: operation.authGeneration,
    ...asset,
    registeredBy: operation.actor.subject,
  });
  return { status: "written", revision: 1 };
}

async function queueOrphan(
  tx: RoomTransaction,
  key: string,
  roomId: string,
): Promise<void> {
  await lockAssetObject(tx, key);
  const [referenced] = await tx
    .select({ key: collaborationAsset.utFileKey })
    .from(collaborationAsset)
    .where(eq(collaborationAsset.utFileKey, key))
    .limit(1);
  if (referenced) return;
  const [queued] = await tx
    .select({ id: deferredFileCleanup.id })
    .from(deferredFileCleanup)
    .where(eq(deferredFileCleanup.utFileKey, key))
    .limit(1);
  if (!queued)
    await tx.insert(deferredFileCleanup).values({
      utFileKey: key,
      reason: "collab-adapter-orphan",
      context: JSON.stringify({ roomId }),
    });
}

async function lockAssetObject(
  tx: RoomTransaction,
  key: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"drawstuff:collab-asset:" + key},0))`,
  );
}

/** No projection can move this fence. A higher epoch waits for all prior room-locked writes to commit. */
export async function applyStorageFence(
  db: Database,
  input: Extract<AdapterCommand, { action: "fence" }>,
) {
  const command = adapterCommandSchema.parse(input);
  if (command.action !== "fence") throw new AdapterError("invalid-body");
  return db.transaction(async (tx) => {
    if (command.state === "ended") {
      // Serialize against parent creation even when no FK parent exists yet.
      await tx
        .insert(collaborationCreationFence)
        .values({ roomId: command.roomId, ended: true })
        .onConflictDoUpdate({
          target: collaborationCreationFence.roomId,
          set: { ended: true },
        });
    }
    const room = await lockRoom(tx, command.roomId);
    if (!room) {
      if (command.state === "ended")
        return { authorityEpoch: command.authorityEpoch };
      throw new AdapterError("not-found");
    }
    if (command.authorityEpoch < room.authorityEpoch)
      return { authorityEpoch: room.authorityEpoch };
    if (
      command.authGeneration < room.storageGeneration ||
      (command.authorityEpoch === room.authorityEpoch &&
        command.authGeneration !== room.storageGeneration) ||
      (room.storageState === "ended" && command.state !== "ended")
    )
      throw new AdapterError("fence-mismatch");
    const rotated = command.authGeneration > room.storageGeneration;
    if (rotated && command.state === "ready")
      throw new AdapterError("initialization-incomplete");
    if (
      rotated &&
      command.state === "initializing" &&
      !command.initializationDeadline
    )
      throw new AdapterError("fence-mismatch");
    if (room.storageState === "initializing" && command.state === "ready") {
      const [snapshot] = await tx
        .select()
        .from(collaborationSnapshot)
        .where(snapshotWhere(command));
      if (
        room.initializationDeadline.getTime() <= Date.now() ||
        room.initializationRevision !== snapshot?.revision ||
        room.initializationChecksum !== snapshot?.checksum
      )
        throw new AdapterError("initialization-incomplete");
    }
    const state =
      !rotated &&
      room.storageState === "ready" &&
      command.state === "initializing"
        ? "ready"
        : command.state;
    await tx
      .update(collaborationRoom)
      .set({
        authorityEpoch: command.authorityEpoch,
        storageGeneration: command.authGeneration,
        storageState: state,
        ...(rotated
          ? {
              snapshotRevision: 0,
              initializationRevision: null,
              initializationChecksum: null,
              initializationAssetIds: [],
              ...(command.initializationDeadline
                ? {
                    initializationDeadline: new Date(
                      command.initializationDeadline,
                    ),
                  }
                : {}),
            }
          : {}),
      })
      .where(eq(collaborationRoom.roomId, command.roomId));
    if (rotated) {
      await tx
        .delete(collaborationSnapshot)
        .where(
          and(
            eq(collaborationSnapshot.roomId, command.roomId),
            lt(collaborationSnapshot.authGeneration, command.authGeneration),
          ),
        );
      const retired = await tx
        .delete(collaborationAsset)
        .where(
          and(
            eq(collaborationAsset.roomId, command.roomId),
            lt(collaborationAsset.authGeneration, command.authGeneration),
          ),
        )
        .returning({ key: collaborationAsset.utFileKey });
      for (const asset of retired.sort((a, b) => a.key.localeCompare(b.key)))
        await queueOrphan(tx, asset.key, command.roomId);
    }
    return { authorityEpoch: command.authorityEpoch };
  });
}

/** DO must recheck local access after the returned bytes/indices arrive, before sending to a browser. */
export async function readAdapterSnapshot(
  db: Database,
  context: StorageContext,
) {
  return (await readAdapterSnapshotState(db, context)).snapshot;
}
export async function readAdapterSnapshotState(
  db: Database,
  context: StorageContext,
) {
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, context.roomId);
    if (!room || !matches(room, context))
      throw new AdapterError("fence-mismatch");
    const [snapshot] = await tx
      .select()
      .from(collaborationSnapshot)
      .where(snapshotWhere(context));
    return {
      snapshot: snapshot ?? null,
      revision: Math.max(room.snapshotRevision, snapshot?.revision ?? 0),
    };
  });
}
export async function readAdapterAssets(
  db: Database,
  context: StorageContext,
  assetIds: string[],
) {
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, context.roomId);
    if (!room || !matches(room, context))
      throw new AdapterError("fence-mismatch");
    if (!assetIds.length) return [];
    return tx
      .select({
        excalidrawFileId: collaborationAsset.excalidrawFileId,
        cryptoVersion: collaborationAsset.cryptoVersion,
        byteLength: collaborationAsset.byteLength,
        url: collaborationAsset.url,
      })
      .from(collaborationAsset)
      .where(
        and(
          assetWhere(context),
          inArray(collaborationAsset.excalidrawFileId, assetIds),
        ),
      );
  });
}

export async function verifyAdapterInitialization(
  db: Database,
  command: Extract<AdapterCommand, { action: "verify-initialization" }>,
) {
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, command.roomId);
    if (
      !room ||
      !matches(room, command) ||
      room.storageState !== "initializing" ||
      room.initializationDeadline.getTime() <= Date.now() ||
      command.manifest.authGeneration !== command.authGeneration
    )
      throw new AdapterError("initialization-incomplete");
    const [snapshot] = await tx
      .select()
      .from(collaborationSnapshot)
      .where(snapshotWhere(command));
    const assets = await tx
      .select({ id: collaborationAsset.excalidrawFileId })
      .from(collaborationAsset)
      .where(assetWhere(command));
    if (
      snapshot?.revision !== command.manifest.revision ||
      snapshot?.checksum !== command.manifest.checksum ||
      command.manifest.assetIds.some(
        (id) => !assets.some((asset) => asset.id === id),
      )
    )
      throw new AdapterError("initialization-incomplete");
    await tx
      .update(collaborationRoom)
      .set({
        initializationRevision: snapshot.revision,
        initializationChecksum: snapshot.checksum,
        initializationAssetIds: command.manifest.assetIds,
      })
      .where(eq(collaborationRoom.roomId, command.roomId));
    return { manifest: command.manifest };
  });
}

/** A confirmed terminal fence precedes cleanup; provider deletion stays in the existing durable cleanup outbox. */
export async function cleanupAdapterRoom(
  db: Database,
  command: Extract<AdapterCommand, { action: "cleanup" }>,
) {
  return db.transaction(async (tx) => {
    const room = await lockRoom(tx, command.roomId);
    if (!room) return { cleaned: true };
    if (
      room.storageState !== "ended" ||
      room.authorityEpoch < command.authorityEpoch ||
      room.storageGeneration !== command.authGeneration
    )
      throw new AdapterError("fence-mismatch");
    const assets = await tx
      .delete(collaborationAsset)
      .where(eq(collaborationAsset.roomId, command.roomId))
      .returning({ key: collaborationAsset.utFileKey });
    for (const asset of assets.sort((a, b) => a.key.localeCompare(b.key)))
      await queueOrphan(tx, asset.key, command.roomId);
    await tx
      .delete(collaborationSnapshot)
      .where(eq(collaborationSnapshot.roomId, command.roomId));
    return { cleaned: true };
  });
}
