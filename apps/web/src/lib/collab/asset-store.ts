import {
  MAX_ROOM_ASSETS,
  MAX_ASSET_LOOKUP_BATCH,
  type CollaborationAssetRecord,
} from "@drawstuff/collaboration/asset";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";

import { withCollaborationRequestDeadline } from "@/lib/collab/request-deadline";
import { createAssetDownloader } from "@/lib/collab/asset-download";
import { createAssetPublisher } from "@/lib/collab/asset-publish";
import {
  createBoundedIdSet,
  createTransferGate,
} from "@/lib/collab/bounded-containers";

/**
 * Client half of room asset transfer: the only place an asset payload is
 * encoded or decoded.
 *
 * The split mirrors the snapshot store's. Authorization comes from the backend
 * (the room API decides who may discover an asset URL and who may upload one),
 * and the stored bytes are the plain asset payload at a public object URL, the
 * same exposure as owned-scene images (ADR-0005).
 *
 * ## What is bounded, and where
 *
 * An asset is three orders of magnitude larger than a scene delta, so every step
 * has a ceiling rather than a best effort:
 *
 * - **Requests.** Lookups are batched (`MAX_ASSET_LOOKUP_BATCH`), never one per
 *   element: a scene with 40 copies of one image asks about one file id, and a
 *   scene with 40 images asks once.
 * - **In flight.** Downloads and uploads run at a fixed concurrency, so a late
 *   joiner with a full room of images holds a few payloads in memory instead of
 *   all of them. Decoded files are delivered in batches of at most four or after
 *   32 ms, so a slow image does not hold back the rest of a lookup.
 * - **Bodies.** A response is read through a bounded reader against the length the
 *   record declares, so a storage endpoint that streams forever is cut off rather
 *   than buffered.
 * - **Bookkeeping.** Every id set is capped at the room's own asset budget with
 *   FIFO eviction. Evicting a resolved id costs one redundant lookup; not capping
 *   it would let a long session grow without limit.
 * - **Retries.** Bounded and only for the failures a retry can fix.
 *
 * There is deliberately no decoded-bytes cache and no object URL. The engine's
 * file store *is* the cache: a decoded asset is handed to `addFiles` and this
 * module keeps only its id. So teardown has nothing to release beyond in-flight
 * requests and one timer.
 *
 * ## Why "missing" is not an error
 *
 * A peer broadcasts an image element the instant it is added and its upload lands
 * a beat later, so the first lookup for a fresh image legitimately finds nothing.
 * That is retried with backoff. A payload that arrives damaged or fails to
 * decode is the opposite case — retrying cannot change it — so it is abandoned,
 * and the scene keeps syncing without the image rather than stalling on it.
 * Abandoning is not the same as saying nothing: see `onAssetsUnreadable`.
 *
 * ## How the module is split
 *
 * This file owns what uploads and downloads *share*: the id verdicts
 * (`resolved`/`abandoned`/`available`), the transfer budget, the retry pacing
 * policy, the batched "given up" report, and teardown. The transfer halves live
 * in `asset-download.ts` and `asset-publish.ts` and receive that shared state as
 * an explicit context; the generic bounded containers are in
 * `bounded-containers.ts`.
 */

/** The backend surface this store needs; the tRPC client and the uploader satisfy it. */
export type AssetApi = {
  /**
   * `signal` is part of the contract rather than an option: leaving a room while a
   * lookup is in flight has to end the lookup, or the store's teardown would only
   * take effect whenever the network happened to answer.
   */
  resolve: (
    input: { roomId: string; fileIds: string[] },
    signal: AbortSignal,
  ) => Promise<{
    assets: CollaborationAssetRecord[];
    missing: string[];
  }>;
  /** Resolves when the payload is stored and recorded; throws otherwise. */
  upload: (input: {
    roomId: string;
    excalidrawFileId: string;
    payload: Uint8Array;
    signal: AbortSignal;
  }) => Promise<void>;
};

export type CollaborationAssetStore = {
  /**
   * Encodes and uploads every file the room does not have yet. Idempotent: a file
   * already published, in flight, or known to be in the room is skipped, so the
   * caller may hand over the whole current file set on every scene flush.
   * Concurrent callers await the shared upload attempt before resolving; this
   * is not a durability receipt, so saves still verify the server records.
   */
  publish: (files: readonly BinaryFileData[]) => Promise<void>;
  /**
   * Fetches and decodes the assets for ids the canvas is missing, handing the
   * results to `onAssetsResolved`. Concurrent calls for one id share a single
   * download.
   */
  request: (fileIds: readonly string[]) => Promise<void>;
  /** Aborts in-flight transfers, cancels the retry timer, and drops all state. */
  destroy: () => void;
  /** Server records prove all referenced asset objects were finalized. */
  areAvailable?: (fileIds: readonly string[]) => Promise<boolean>;
};

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_MS = 250;
/** Ceiling on the backoff, and the floor on how often one id may be re-requested. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Simultaneous transfers **for the whole store**, uploads and downloads together.
 * Four is the same order as a browser's per-host connection budget, and it caps
 * peak memory at four payloads plus their decoded images rather than a whole
 * room's worth. Per-call limiting would not do that: two overlapping scene
 * messages would each open their own budget.
 */
const MAX_CONCURRENT_TRANSFERS = 4;

/** Every id set and id map is capped at the room's own budget. */
const MAX_TRACKED_IDS = MAX_ROOM_ASSETS;

const defaultScheduleTimeout = (
  run: () => void,
  delayMs: number,
): (() => void) => {
  const timerId = setTimeout(run, delayMs);
  return () => clearTimeout(timerId);
};

const retryDelayMs = (attempts: number): number =>
  Math.min(
    RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** (attempts - 1),
    MAX_RETRY_DELAY_MS,
  ) + Math.floor(Math.random() * RETRY_JITTER_MS);

export function createCollaborationAssetStore(options: {
  api: AssetApi;
  roomId: RoomId;
  /** Called with every batch of decoded assets, for injection into the canvas. */
  onAssetsResolved: (files: readonly BinaryFileData[]) => void;
  /**
   * The room has an image whose stored bytes arrived damaged or would not
   * decode. Called at most once per store: "not uploaded yet" is retried and
   * never reports here, while a damaged image is final and would otherwise be
   * a canvas quietly short an image, with no message.
   */
  onAssetsUnreadable?: () => void;
  /**
   * Ids this client has given up on, batched. Retrying cannot produce these
   * images — the body disagrees with its record or will not decode, the local
   * file is too large to publish, or the upload budget is spent — so the canvas
   * can say so instead of showing them as still loading.
   *
   * Separate from `onAssetsUnreadable`, which is one room-level statement that
   * stored images are damaged; this is per image and is the union of every
   * terminal reason.
   */
  onAssetsUnavailable?: (fileIds: readonly string[]) => void;
  /**
   * Asks the canvas to offer its files again after a failed upload.
   *
   * Inverted rather than retried from here on purpose: a retry has to use the
   * *current* scene, or it would re-upload an image the user has since deleted —
   * and holding the bytes for a retry would pin megabytes the engine already owns.
   */
  onPublishRetryDue?: () => void;
  /** Injected by tests so retry backoff does not depend on wall time. */
  scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
  now?: () => number;
  /** Injected by tests; production uses the global. */
  fetchImpl?: typeof fetch;
}): CollaborationAssetStore {
  const {
    api,
    roomId,
    onAssetsResolved,
    onAssetsUnreadable,
    onAssetsUnavailable,
    onPublishRetryDue,
    scheduleTimeout = defaultScheduleTimeout,
    now = Date.now,
    fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, init),
  } = options;

  const controller = new AbortController();
  let destroyed = false;
  const isDestroyed = (): boolean => destroyed;

  /** Ids already handed to the canvas; never downloaded twice. */
  const resolved = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids no retry can help: damaged, undecodable, or out of attempts. */
  const abandoned = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids this client has uploaded or seen in the room. */
  const available = createBoundedIdSet(MAX_TRACKED_IDS);
  const transfers = createTransferGate(MAX_CONCURRENT_TRANSFERS);

  /**
   * Ids given up on since the last report, awaiting one batched notification.
   *
   * Batched rather than reported per id because the caller turns this into a
   * scene write, and a late joiner with ten damaged images must produce one
   * canvas update, not ten.
   */
  let unavailableIds: string[] = [];

  /**
   * The single place an id is given up on. Centralised so a terminal failure
   * cannot be added to `abandoned` without the canvas being told.
   */
  const abandon = (fileId: string): void => {
    if (abandoned.has(fileId)) return;
    abandoned.add(fileId);
    unavailableIds.push(fileId);
  };

  const flushUnavailable = (): void => {
    if (destroyed || unavailableIds.length === 0) return;
    const reported = unavailableIds;
    unavailableIds = [];
    onAssetsUnavailable?.(reported);
  };

  let reportedUnreadable = false;
  const noteUnreadableAsset = (): void => {
    if (destroyed || reportedUnreadable) return;
    reportedUnreadable = true;
    onAssetsUnreadable?.();
  };

  const downloader = createAssetDownloader({
    resolve: api.resolve,
    roomId,
    fetchImpl,
    signal: controller.signal,
    isDestroyed,
    now,
    scheduleTimeout,
    retryDelayMs,
    maxTrackedIds: MAX_TRACKED_IDS,
    transfers,
    resolved,
    abandoned,
    available,
    abandon,
    flushUnavailable,
    noteUnreadableAsset,
    onAssetsResolved,
  });

  const publisher = createAssetPublisher({
    upload: api.upload,
    roomId,
    signal: controller.signal,
    isDestroyed,
    now,
    scheduleTimeout,
    retryDelayMs,
    maxTrackedIds: MAX_TRACKED_IDS,
    transfers,
    resolved,
    abandoned,
    available,
    abandon,
    flushUnavailable,
    onPublishRetryDue,
  });

  return {
    publish: publisher.publish,
    request: downloader.request,
    async areAvailable(fileIds) {
      if (destroyed) return false;
      try {
        for (
          let offset = 0;
          offset < fileIds.length;
          offset += MAX_ASSET_LOOKUP_BATCH
        ) {
          const batch = fileIds.slice(offset, offset + MAX_ASSET_LOOKUP_BATCH);
          const result = await withCollaborationRequestDeadline(
            (signal) => api.resolve({ roomId, fileIds: [...batch] }, signal),
            controller.signal,
          );
          const present = new Set(
            result.assets.map((asset) => asset.excalidrawFileId),
          );
          if (batch.some((id) => !present.has(id))) return false;
        }
        return !destroyed;
      } catch {
        return false;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      downloader.dispose();
      publisher.dispose();
      // Aborts fetches, uploads and lookups alike: every network call this store
      // makes carries this signal.
      controller.abort();
    },
  };
}
