import type { SyncedElement } from "@drawstuff/collaboration/protocol";
import { EXCALIDRAW_CAPTURE_UPDATE_ACTION } from "@drawstuff/excalidraw-adapter/client";
import { collectReferencedFileIds } from "@drawstuff/excalidraw-adapter/codec";
import { markImageElementsUnavailable } from "@drawstuff/excalidraw-adapter/reconcile";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";

import type { CollaborationAssetStore } from "@/lib/collab/asset-store";
import type { SessionContext } from "@/lib/collab/session/session-context";

export type AssetBridge = {
  requestMissingAssets(elements: readonly SyncedElement[]): void;
  publishLocalAssets(params?: { force?: boolean }): void;
  /** Forgets the last offer so the next flush re-offers; every connection change. */
  resetOfferCache(): void;
  applyRemoteAssets(files: readonly BinaryFileData[]): void;
  applyUnavailableAssets(fileIds: readonly string[]): void;
};

/**
 * The session's two-way bridge to the asset store: what the canvas is missing
 * is requested, what the canvas holds is offered, and what the store settles —
 * bytes or a verdict — is written back onto the canvas.
 *
 * An absent store means images are not exchanged — used by tests that exercise
 * element sync in isolation, which is also the honest description of what a
 * session without it does.
 */
export const createAssetBridge = (options: {
  context: SessionContext;
  assetStore: CollaborationAssetStore | undefined;
  /**
   * `destroy()` only — not the terminal recovery state. Remote asset writes are
   * store callbacks that may settle while a terminated session still owns the
   * canvas, and the original entry points gated on teardown alone.
   */
  isDestroyed(): boolean;
  wrapRemoteApply(apply: () => void): void;
}): AssetBridge => {
  const { context, assetStore, isDestroyed, wrapRemoteApply } = options;
  const { sceneApi } = context;

  /**
   * The referenced file ids last handed to the store. An unchanged set skips
   * the store call and the file-map build: the store already saw this exact
   * offer, and re-offering it per flush is pure overhead. `force` (the store's
   * own retry timer) bypasses the skip, because a retry exists precisely to
   * re-offer what an earlier flush already offered.
   */
  let lastOfferedFileIds = "";

  return {
    /**
     * Asks the asset store for the images the elements just applied reference
     * and the canvas does not have.
     *
     * Driven by the *incoming* elements rather than by the whole scene, which is
     * what keeps a delta cheap: a pointer-drag of an existing image references an
     * id the canvas already holds and produces no request at all. A join baseline
     * happens to be the whole scene, so the same call covers the late-joiner and
     * page-refresh cases.
     *
     * Fire-and-forget on purpose. A missing or unopenable asset must never hold
     * up element sync — the scene converges and the image either arrives later or
     * does not.
     */
    requestMissingAssets(elements) {
      if (!assetStore || isDestroyed() || !context.canSyncScene()) return;
      const files = sceneApi.getFiles();
      const missing = collectReferencedFileIds(elements).filter(
        (fileId) => !files[fileId],
      );
      if (missing.length === 0) return;
      void assetStore.request(missing);
    },

    /**
     * Publishes the images the local canvas holds and the room does not.
     *
     * Runs on the same coalesced flush as the outbound deltas, because that is
     * when a newly added image is first broadcast: peers receive the element and
     * the ciphertext lands moments later. The store decides what is actually new,
     * so calling this repeatedly is how a failed upload is retried — and a scene
     * with no files at all never walks its elements.
     */
    publishLocalAssets(params) {
      if (!assetStore || !context.canEditScene()) return;
      const files = sceneApi.getFiles();
      // Nothing publishable clears the latch rather than keeping it. Holding a
      // latch across an empty set is how an image gets stranded: an upload that
      // failed while its element was deleted spends its retry on this empty
      // flush, and the undo that brings the element back would then produce the
      // very offer the latch is still holding.
      if (Object.keys(files).length === 0) {
        lastOfferedFileIds = "";
        return;
      }
      const pending: BinaryFileData[] = [];
      for (const fileId of collectReferencedFileIds(
        sceneApi.getSceneElementsIncludingDeleted(),
      )) {
        const file = files[fileId];
        if (file) pending.push(file);
      }
      if (pending.length === 0) {
        lastOfferedFileIds = "";
        return;
      }
      // Keyed on the ids actually being offered, not on the engine's file-store
      // keys. Those two differ whenever the store holds a file no live element
      // references — a deleted image, or a file that landed before its element —
      // and keying on the store would then latch an id that was never offered,
      // so the flush that finally references it would be skipped and the image
      // would never reach the room.
      const offer = pending
        .map((file) => file.id)
        .sort()
        .join("\n");
      if (params?.force !== true && offer === lastOfferedFileIds) return;
      lastOfferedFileIds = offer;
      void assetStore.publish(pending);
    },

    /**
     * Forgets what was offered, so the next flush re-offers it.
     *
     * Called on every connection transition. A publish retry that fires while
     * the session is down is refused here (no live role) and consumes its timer,
     * so the rejoin publish has to be a real offer rather than a cache hit — it
     * is the only thing left that would carry that image into the room.
     */
    resetOfferCache() {
      lastOfferedFileIds = "";
    },

    /**
     * Injects assets the asset store opened. Same guards as any other remote
     * write: a canvas that no longer belongs to the room must not gain the
     * room's images, and the write must not mark the scene dirty.
     */
    applyRemoteAssets(files) {
      if (isDestroyed() || files.length === 0 || !context.canSyncScene()) {
        return;
      }
      wrapRemoteApply(() => {
        sceneApi.addFiles([...files]);
      });
    },

    /**
     * Marks the image elements whose bytes this client will never obtain, so the
     * canvas draws the engine's error placeholder rather than the loading one.
     */
    applyUnavailableAssets(fileIds) {
      if (isDestroyed() || fileIds.length === 0 || !context.canSyncScene()) {
        return;
      }
      wrapRemoteApply(() => {
        const marked = markImageElementsUnavailable(
          sceneApi.getSceneElementsIncludingDeleted(),
          new Set(fileIds),
        );
        // Nothing on this canvas referenced those ids — the element may have been
        // deleted while its download was still running.
        if (!marked) return;
        sceneApi.updateScene({
          elements: marked,
          captureUpdate: EXCALIDRAW_CAPTURE_UPDATE_ACTION.NEVER,
        });
      });
    },
  };
};
