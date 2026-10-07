import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import { encodeCollaborationAssetPayload } from "@drawstuff/collaboration/asset";
import { TRPCClientError } from "@trpc/client";
import { encodeCollaborationSnapshot } from "@drawstuff/collaboration/snapshot";
import {
  sealRoomKeyCheck,
  verifyRoomKeyCheck,
} from "@drawstuff/collaboration/keycheck";
import { decodeBase64, encodeBase64 } from "@drawstuff/collaboration/base64";
import {
  roomIdSchema,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
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

/** Browser-only initialization. Unknown replies keep the room, key, captured elements and every intent. */
export function createRoomInitialization(options: {
  authority: AuthorityApi;
  snapshots: SnapshotApi;
  sceneId: string;
  elements: readonly SyncedElement[];
  files?: readonly BinaryFileData[];
  assets?: AssetApi;
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
  const roomKey = generateRoomKey();
  const creation = {
    ...authorityEnvelope(roomId),
    action: "create",
    sceneId: options.sceneId,
    label: "",
    linkRole: "none",
  } as const;
  const create = createAuthorityOperation(options.authority, creation);
  let setCheck: ReturnType<typeof createAuthorityOperation> | undefined;
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
  const start = async () => {
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
      if (state.authGeneration !== 1)
        throw new AuthorityRoomError("generation-mismatch");
      if (!setCheck) {
        const keyCheckBase64 = await sealRoomKeyCheck({
          roomKey,
          roomId,
          authGeneration: 1,
        });
        const decoded = decodeBase64(keyCheckBase64, { maxBytes: 256 });
        if (!decoded.ok) throw new Error("key-check-encoding-failed");
        setCheck = createAuthorityOperation(options.authority, {
          ...authorityEnvelope(roomId),
          action: "set-key-check",
          expectedGeneration: 1,
          keyCheck: Array.from(decoded.bytes),
        });
      }
      assertActive();
      await setCheck();
      assertActive();
      if (assetIds.length) {
        assets ??= await createCollaborationAssetStore({
          api: options.assets!,
          roomId,
          roomKey,
          authGeneration: 1,
          onAssetsResolved: () => undefined,
        });
        if (disposed) assets.destroy();
        assertActive();
        await assets.publish(files);
        assertActive();
        if (!(await assets.areAvailable?.(assetIds)))
          throw new AuthorityRoomError("pending");
      }
      assertActive();
      store ??= await createCollaborationSnapshotStore({
        api: options.snapshots,
        roomId,
        roomKey,
        authGeneration: 1,
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
        manifest: { authGeneration: 1, ...stored, assetIds },
      });
      assertActive();
      await complete();
      assertActive();
      const ready = await readAuthorityState(options.authority, roomId);
      assertActive();
      if (ready.state !== "ready") throw new AuthorityRoomError(ready.state);
      if (
        ready.authGeneration !== 1 ||
        !ready.keyCheck ||
        !(await verifyRoomKeyCheck({
          roomKey,
          roomId,
          authGeneration: 1,
          keyCheckBase64: encodeBase64(new Uint8Array(ready.keyCheck)),
        }))
      )
        throw new AuthorityRoomError("generation-mismatch");
      assets?.destroy();
      return { roomId, roomKey };
    } finally {
      active = false;
    }
  };
  return {
    start,
    dispose() {
      disposed = true;
      assets?.destroy();
    },
    async cancel() {
      if (active) throw new AuthorityRoomError("pending");
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
