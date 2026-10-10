import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import { encodeCollaborationAssetPayload } from "@drawstuff/collaboration/asset";
import { TRPCClientError } from "@trpc/client";
import { encodeCollaborationSnapshot } from "@drawstuff/collaboration/snapshot";
import {
  roomIdSchema,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { collectReferencedFileIds } from "@drawstuff/excalidraw-adapter/codec";
import {
  AuthorityRoomError,
  authorityEnvelope,
  createAuthorityOperation,
  readAuthorityState,
  type AuthorityApi,
} from "./authority-client";
import {
  createCollaborationSnapshotStore,
  type CollaborationSnapshotStore,
} from "./snapshot-store";
import {
  createCollaborationAssetStore,
  type AssetApi,
  type CollaborationAssetStore,
} from "./asset-store";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";
import type { SnapshotApi } from "./snapshot-http";

/**
 * How long a product start waits for Room to confirm pending steps before
 * asking the person to retry. Room confirms creation and completion only after
 * its background registration, typically within a few seconds.
 */
export const INITIALIZATION_SETTLE_MS = 15_000;
/** Room's own cap on a room name (authority schema `label: max(120)`). */
export const ROOM_LABEL_MAX_LENGTH = 120;
const SETTLE_FIRST_DELAY_MS = 250;
const SETTLE_MAX_DELAY_MS = 2_000;

/** Browser-only initialization. Unknown replies keep the room, captured elements and every intent. */
export function createRoomInitialization(options: {
  authority: AuthorityApi;
  snapshots: SnapshotApi;
  sceneId: string | null;
  /** The room's name as the owner typed it; trimmed and capped at 120. */
  label?: string;
  elements: readonly SyncedElement[];
  files?: readonly BinaryFileData[];
  assets?: AssetApi;
  /**
   * Keep re-checking a step Room reports as pending for up to this long
   * before rejecting with `pending`. Zero (the default) rejects at once.
   */
  settleWithinMs?: number;
}) {
  // Capture both elements and files before any asynchronous work; incomplete source images cannot seed a room.
  const elements = structuredClone(options.elements);
  const assetIds = collectReferencedFileIds(elements);
  const files = structuredClone(options.files ?? []).filter((file) =>
    assetIds.includes(file.id),
  );
  if (
    assetIds.length > AUTHORITY_LIMITS.initializationAssets ||
    (assetIds.length &&
      (!options.assets ||
        assetIds.some((id) => !files.some((file) => file.id === id))))
  )
    throw new AuthorityRoomError("attachments-required");
  const roomId = roomIdSchema.parse(crypto.randomUUID());
  if (
    files.some(
      (file) =>
        !encodeCollaborationAssetPayload({
          roomId,
          excalidrawFileId: file.id,
          mimeType: file.mimeType,
          dataUrl: file.dataURL,
        }).ok,
    )
  )
    throw new AuthorityRoomError("attachments-required");
  if (!encodeCollaborationSnapshot({ roomId, elements }).ok)
    throw new Error("invalid-initial-snapshot");
  const creation = {
    ...authorityEnvelope(roomId),
    action: "create" as const,
    sceneId: options.sceneId,
    label: (options.label ?? "").trim().slice(0, ROOM_LABEL_MAX_LENGTH),
    linkRole: "none" as const,
  };
  const create = createAuthorityOperation(options.authority, creation);
  let complete: ReturnType<typeof createAuthorityOperation> | undefined;
  let store: CollaborationSnapshotStore | undefined;
  let assets: CollaborationAssetStore | undefined;
  let expectedRevision: number | undefined;
  let stored: { revision: number; checksum: string } | undefined;
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new AuthorityRoomError("cancelled");
  };
  let active = false;
  let cancelled = false;
  let abandoning = false;
  let cancel: ReturnType<typeof createAuthorityOperation> | undefined;
  /** Between pending re-checks: still started, so cancel must wait. */
  let settling = false;
  const attempt = async () => {
    if (disposed || cancelled || abandoning)
      throw new AuthorityRoomError("cancelled");
    if (active) throw new AuthorityRoomError("pending");
    active = true;
    try {
      await create(); // Enforced means the immutable parent job was confirmed.
      assertActive();
      const state = await readAuthorityState(options.authority, roomId);
      assertActive();
      if (state.state === "ended") throw new AuthorityRoomError("ended");
      if (assetIds.length) {
        assets ??= createCollaborationAssetStore({
          api: options.assets!,
          roomId,
          onAssetsResolved: () => undefined,
        });
        await assets.publish(files);
        assertActive();
        if (!(await assets.areAvailable?.(assetIds)))
          throw new AuthorityRoomError("pending");
      }
      assertActive();
      store ??= createCollaborationSnapshotStore({
        api: options.snapshots,
        roomId,
      });
      if (!stored) {
        if (expectedRevision === undefined) {
          const baseline = await store.load();
          if (baseline.status === "unreadable")
            throw new Error("initial-snapshot-unavailable");
          expectedRevision = baseline.revision ?? 0;
        }
        assertActive();
        const result = await store.save({ elements, expectedRevision });
        assertActive();
        if (result.status === "conflict") expectedRevision = undefined;
        if (result.status !== "written" || !result.checksum)
          throw new AuthorityRoomError("pending");
        stored = { revision: result.revision, checksum: result.checksum };
      }
      complete ??= createAuthorityOperation(options.authority, {
        ...authorityEnvelope(roomId),
        action: "complete-initialization",
        manifest: { ...stored, assetIds },
      });
      assertActive();
      const { projectionPending } = await complete();
      assertActive();
      const ready = await readAuthorityState(options.authority, roomId);
      assertActive();
      if (ready.state !== "ready") throw new AuthorityRoomError(ready.state);
      assets?.destroy();
      return { roomId, projectionPending };
    } finally {
      active = false;
    }
  };
  // Every step keeps its intent across attempts, so re-running resumes where
  // Room last answered pending instead of repeating confirmed work.
  const start = async () => {
    if (active || settling) throw new AuthorityRoomError("pending");
    const deadline = Date.now() + (options.settleWithinMs ?? 0);
    try {
      for (let delay = SETTLE_FIRST_DELAY_MS; ;) {
        settling = false;
        try {
          return await attempt();
        } catch (error) {
          const remaining = deadline - Date.now();
          if (
            !(
              error instanceof AuthorityRoomError && error.code === "pending"
            ) ||
            remaining <= 0 ||
            disposed
          )
            throw error;
          settling = true;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(delay, remaining)),
          );
          delay = Math.min(delay * 2, SETTLE_MAX_DELAY_MS);
        }
      }
    } finally {
      settling = false;
    }
  };
  return {
    roomId,
    start,
    dispose() {
      disposed = true;
      assets?.destroy();
    },
    async cancel() {
      if (active || settling) throw new AuthorityRoomError("pending");
      if (cancelled) return;
      abandoning = true;
      try {
        const state = await readAuthorityState(options.authority, roomId);
        if (state.state === "ended" && !cancel) {
          cancelled = true;
          assets?.destroy();
          return;
        }
      } catch (error) {
        if (
          creation.deadline <= Date.now() &&
          error instanceof TRPCClientError &&
          (error.data as { code?: unknown } | undefined)?.code === "NOT_FOUND"
        ) {
          cancelled = true;
          assets?.destroy();
          return;
        }
        throw error;
      }
      cancel ??= createAuthorityOperation(options.authority, {
        ...authorityEnvelope(roomId),
        action: "end-room",
      });
      try {
        await cancel();
      } catch (error) {
        // A queried, absent and expired intent is known not to have been
        // accepted. A later cancel click may safely create a fresh end intent.
        if (
          error instanceof AuthorityRoomError &&
          error.code === "expired-operation"
        )
          cancel = undefined;
        throw error;
      }
      cancelled = true;
      assets?.destroy();
    },
  };
}
