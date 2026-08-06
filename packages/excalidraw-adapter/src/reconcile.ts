import {
  isInvisiblySmallElement,
  newElementWith,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { MakeBrand } from "@excalidraw/excalidraw/utility-types";

export type { ReconciledExcalidrawElement };

/**
 * How long a deleted tombstone keeps flowing through collaboration sync after
 * its last mutation, mirroring the upstream collab app's
 * `DELETED_ELEMENT_TIMEOUT` (excalidraw-app/app_constants.ts). Older
 * tombstones stop being broadcast — this is the sync-scope compaction
 * boundary; owned-scene persistence keeps every tombstone regardless.
 */
export const DELETED_ELEMENT_SYNC_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type SyncableExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"DrawstuffSyncableElement">;

/**
 * The slice of `AppState` that `reconcileElements` actually reads: the three
 * "this element is mid-interaction locally" locks that force the local
 * element to win (`shouldDiscardRemoteElement`,
 * packages/excalidraw/data/reconcile.ts:19-40 at 0.18.1). A full `AppState`
 * from `getAppState()` is assignable as-is.
 */
export type ReconciliationLocalState = Pick<
  AppState,
  "editingTextElement" | "newElement" | "resizingElement"
>;

/**
 * Merges remote element updates into the local scene through the upstream
 * engine, replicating the composition of the upstream collab app's
 * `Collab._reconcileElements` one-to-one: remote wire elements are first
 * normalized by `restoreElements` (which also shields the wire objects from
 * the in-place fractional-index repair `reconcileElements` may perform), then
 * merged by `reconcileElements`. All conflict resolution — version winner,
 * versionNonce tie-break, editing locks, fractional-index ordering — is owned
 * by upstream; Drawstuff adds no second merge algorithm.
 */
export function reconcileRemoteElements(
  localElements: readonly OrderedExcalidrawElement[],
  remoteElements: readonly ExcalidrawElement[],
  localState: ReconciliationLocalState,
): ReconciledExcalidrawElement[] {
  const restoredRemoteElements = restoreElements(
    remoteElements,
    null,
  ) as RemoteExcalidrawElement[];

  return reconcileElements(
    localElements,
    restoredRemoteElements,
    localState as AppState,
  );
}

/**
 * Upstream collab app sync policy (`isSyncableElement`,
 * excalidraw-app/data/index.ts): live elements sync unless invisibly small,
 * deleted tombstones sync only within {@link DELETED_ELEMENT_SYNC_TIMEOUT_MS}
 * of their last mutation so deletions converge across clients without
 * broadcasting stale tombstones forever.
 */
export function isSyncableElement(
  element: OrderedExcalidrawElement,
  now: number = Date.now(),
): element is SyncableExcalidrawElement {
  if (element.isDeleted) {
    return element.updated > now - DELETED_ELEMENT_SYNC_TIMEOUT_MS;
  }
  return !isInvisiblySmallElement(element);
}

/**
 * Marks the image elements whose bytes this client will never obtain.
 *
 * The engine already draws two different placeholders for an image it cannot
 * show — `status: "error"` gets a distinct glyph from the "still loading" one
 * (`renderElement.ts`, `IMAGE_ERROR_PLACEHOLDER_IMG`) — so the distinction
 * between "this image has not arrived yet" and "this image is never going to"
 * is available through the element model alone. This is the upstream collab
 * app's own mechanism (`updateStaleImageStatuses`, excalidraw-app/data/
 * FileManager.ts), reached through the public `newElementWith`.
 *
 * Returns `null` when nothing changed, so a caller can skip the scene write
 * entirely; `newElementWith` is itself idempotent, so re-marking an element
 * already in error is not a version bump.
 *
 * The mark travels with the element on the next broadcast, exactly as it does
 * upstream. That is not a leak of a local-only fact: the engine renders an
 * image from the *bytes* in its file store, not from this field, so a peer that
 * holds the image still draws it. The field only chooses which placeholder a
 * client that lacks the bytes is shown.
 */
export function markImageElementsUnavailable(
  elements: readonly OrderedExcalidrawElement[],
  fileIds: ReadonlySet<string>,
): readonly OrderedExcalidrawElement[] | null {
  if (fileIds.size === 0) return null;
  let changed = false;
  const next = elements.map((element) => {
    if (
      element.type !== "image" ||
      element.status === "error" ||
      element.fileId === null ||
      !fileIds.has(element.fileId)
    ) {
      return element;
    }
    changed = true;
    return newElementWith(element, { status: "error" });
  });
  return changed ? next : null;
}

export function getSyncableElements(
  elements: readonly OrderedExcalidrawElement[],
  now: number = Date.now(),
): SyncableExcalidrawElement[] {
  return elements.filter((element): element is SyncableExcalidrawElement =>
    isSyncableElement(element, now),
  );
}

/**
 * The identity triple reconciliation converges on. Wire payloads validated by
 * `@drawstuff/collaboration` satisfy this without casting to full elements.
 */
export type SyncedElementIdentity = Pick<
  ExcalidrawElement,
  "id" | "version" | "versionNonce"
>;

export interface ExtractedElementBatch {
  /**
   * The changed syncable elements, in scene order and by reference (no
   * clones). Serialize and send these within the flush that extracted them.
   */
  readonly elements: readonly SyncableExcalidrawElement[];
  /**
   * Commits this batch after the transport accepted it. The commit writes
   * the identity snapshots captured at extraction time — never the live
   * (mutable) element objects — so an element mutated in place after
   * extraction, an overlapping later extraction, or a delayed stale commit
   * can only cause a re-send, never a silent loss: a snapshot older than the
   * recorded synced state is skipped, and a batch created before `reset()`
   * commits nothing. Idempotent.
   */
  markSent(): void;
}

export interface ChangedElementTracker {
  /**
   * Returns the syncable elements whose `version`/`versionNonce` moved since
   * they were last marked sent or adopted. One pass over the live scene
   * array; a pointer-only change extracts nothing. `syncAll` ignores the
   * recorded state and returns every syncable element (scene-init / periodic
   * full resync).
   *
   * Extraction records nothing: only {@link ExtractedElementBatch.markSent}
   * commits, so a batch whose send is rejected by the transport is simply
   * extracted again — a forgotten commit re-sends, it never loses an edit.
   */
  extractChangedElements(
    sceneElements: readonly OrderedExcalidrawElement[],
    options?: { readonly now?: number; readonly syncAll?: boolean },
  ): ExtractedElementBatch;
  /**
   * Records the remote elements the reconciled scene actually adopted (same
   * id, version and versionNonce as the reconciled result) so a received
   * update is not echoed back on the next local extraction. Elements the
   * local side won stay pending and are still broadcast. Call after
   * {@link reconcileRemoteElements} with its result and the same wire
   * elements.
   */
  markAdoptedRemoteElements(
    reconciledElements: readonly OrderedExcalidrawElement[],
    remoteElements: readonly SyncedElementIdentity[],
  ): void;
  /** Forgets all recorded state; use when joining a room or session. */
  reset(): void;
}

/**
 * Tracks the last per-element state this client sent (or adopted from a
 * peer), keyed by upstream `version`/`versionNonce` exactly as the upstream
 * collab app's `Portal.broadcastedElementVersions` does, so a scene delta
 * serializes only changed elements instead of the whole scene.
 */
export function createChangedElementTracker(): ChangedElementTracker {
  const syncedVersions = new Map<
    string,
    { version: number; versionNonce: number }
  >();
  /** Bumped by reset(); voids commits from batches of an earlier session. */
  let sessionGeneration = 0;

  const hasChanged = (element: OrderedExcalidrawElement): boolean => {
    const synced = syncedVersions.get(element.id);
    return (
      synced === undefined ||
      element.version > synced.version ||
      (element.version === synced.version &&
        element.versionNonce !== synced.versionNonce)
    );
  };

  return {
    extractChangedElements(sceneElements, options) {
      const now = options?.now ?? Date.now();
      const syncAll = options?.syncAll ?? false;
      const batchGeneration = sessionGeneration;
      const changedElements: SyncableExcalidrawElement[] = [];
      // Immutable identity snapshots owned by this batch alone: a later
      // extraction cannot overwrite them, and they are collected with the
      // batch, so no per-tracker pending state accumulates.
      const snapshots: SyncedElementIdentity[] = [];

      for (const element of sceneElements) {
        if (
          (syncAll || hasChanged(element)) &&
          isSyncableElement(element, now)
        ) {
          changedElements.push(element);
          snapshots.push({
            id: element.id,
            version: element.version,
            versionNonce: element.versionNonce,
          });
        }
      }

      return {
        elements: changedElements,
        markSent() {
          if (batchGeneration !== sessionGeneration) {
            return;
          }
          for (const snapshot of snapshots) {
            const synced = syncedVersions.get(snapshot.id);
            // A strictly newer synced record (later commit or remote
            // adoption) wins over a stale delayed commit. An equal-version
            // record is still overwritten so the tracker converges on the
            // wire state; the worst case is one self-healing re-send.
            if (synced === undefined || synced.version <= snapshot.version) {
              syncedVersions.set(snapshot.id, {
                version: snapshot.version,
                versionNonce: snapshot.versionNonce,
              });
            }
          }
        },
      };
    },
    markAdoptedRemoteElements(reconciledElements, remoteElements) {
      if (remoteElements.length === 0) {
        return;
      }

      const remoteById = new Map(
        remoteElements.map((element) => [element.id, element]),
      );
      for (const element of reconciledElements) {
        const remote = remoteById.get(element.id);
        if (
          remote?.version === element.version &&
          remote.versionNonce === element.versionNonce
        ) {
          syncedVersions.set(element.id, {
            version: element.version,
            versionNonce: element.versionNonce,
          });
        }
      }
    },
    reset() {
      syncedVersions.clear();
      sessionGeneration += 1;
    },
  };
}
