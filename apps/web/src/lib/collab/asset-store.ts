import {
  createAssetCryptoCodec,
  MAX_ROOM_ASSETS_PER_GENERATION,
  type ASSET_CRYPTO_VERSION,
  type CollaborationAssetRecord,
} from "@drawstuff/collaboration/asset";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";

import { createAssetDownloader } from "@/lib/collab/asset-download";
import { createAssetPublisher } from "@/lib/collab/asset-publish";
import { createUnreadableAssetVerdict } from "@/lib/collab/asset-unreadable-verdict";
import {
  createBoundedIdSet,
  createTransferGate,
} from "@/lib/collab/bounded-containers";

/**
 * Client half of encrypted asset transfer: the only place an asset is sealed or
 * opened.
 *
 * The split mirrors the snapshot store's. Authorization comes from the backend
 * (the room API decides who may discover an asset URL and who may upload one);
 * confidentiality comes from the URL fragment (the room key, which never leaves
 * the browser). So this module needs both, and everything below it handles
 * ciphertext only — there is no code path that could upload a readable image,
 * because `publish` seals before it calls the API and `request` opens after.
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
 *   joiner with a full room of images holds a few ciphertexts in memory instead of
 *   all of them.
 * - **Bodies.** A response is read through a bounded reader against the length the
 *   record declares, so a storage endpoint that streams forever is cut off rather
 *   than buffered.
 * - **Bookkeeping.** Every id set is capped at the room's own asset budget with
 *   FIFO eviction. Evicting a resolved id costs one redundant lookup; not capping
 *   it would let a long session grow without limit.
 * - **Retries.** Bounded and only for the failures a retry can fix.
 *
 * There is deliberately no decrypted-bytes cache and no object URL. The engine's
 * file store *is* the cache: an opened asset is handed to `addFiles` and this
 * module keeps only its id. So teardown has nothing to release beyond in-flight
 * requests and one timer.
 *
 * ## Why "missing" is not an error
 *
 * A peer broadcasts an image element the instant it is added and its upload lands
 * a beat later, so the first lookup for a fresh image legitimately finds nothing.
 * That is retried with backoff. A payload that fails to open or decode is the
 * opposite case — retrying cannot change it — so it is abandoned, and the scene
 * keeps syncing without the image rather than stalling on it.
 *
 * Abandoning is not the same as saying nothing, though, and the two used to be.
 * "Not uploaded yet" and "this link will never open it" both showed the user the
 * same blank space, so a room whose images are all sealed under a key this link
 * does not have looked exactly like a room whose peers are merely slow. The
 * per-asset handling is unchanged — see `onAssetsUnreadable` for the aggregate
 * that makes the second case visible without making the first one noisy.
 *
 * ## How the module is split
 *
 * This file owns what uploads and downloads *share*: the id verdicts
 * (`resolved`/`abandoned`/`available`), the transfer budget, the retry pacing
 * policy, the batched "given up" report, and teardown. The transfer halves live
 * in `asset-download.ts` and `asset-publish.ts` and receive that shared state as
 * an explicit context; the room-level unreadable verdict is its own small
 * machine in `asset-unreadable-verdict.ts`, and the generic bounded containers
 * are in `bounded-containers.ts`.
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
    authGeneration: number;
    assets: CollaborationAssetRecord[];
    missing: string[];
  }>;
  /** Resolves when the ciphertext is stored and recorded; throws otherwise. */
  upload: (input: {
    roomId: string;
    /** Generation the ciphertext was sealed for; the server refuses a mismatch. */
    authGeneration: number;
    excalidrawFileId: string;
    cryptoVersion: typeof ASSET_CRYPTO_VERSION;
    ciphertext: Uint8Array;
    signal: AbortSignal;
  }) => Promise<void>;
};

export type CollaborationAssetStore = {
  /**
   * Seals and uploads every file the room does not have yet. Idempotent: a file
   * already published, in flight, or known to be in the room is skipped, so the
   * caller may hand over the whole current file set on every scene flush.
   */
  publish: (files: readonly BinaryFileData[]) => Promise<void>;
  /**
   * Fetches and opens the assets for ids the canvas is missing, handing the
   * results to `onAssetsResolved`. Concurrent calls for one id share a single
   * download.
   */
  request: (fileIds: readonly string[]) => Promise<void>;
  /** Aborts in-flight transfers, cancels the retry timer, and drops all state. */
  destroy: () => void;
};

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_MS = 250;
/** Ceiling on the backoff, and the floor on how often one id may be re-requested. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Simultaneous transfers **for the whole store**, uploads and downloads together.
 * Four is the same order as a browser's per-host connection budget, and it caps
 * peak memory at four ciphertexts plus their plaintexts rather than a whole
 * room's worth. Per-call limiting would not do that: two overlapping scene
 * messages would each open their own budget.
 */
const MAX_CONCURRENT_TRANSFERS = 4;

/** Every id set and id map is capped at the room's own budget. */
const MAX_TRACKED_IDS = MAX_ROOM_ASSETS_PER_GENERATION;

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

export async function createCollaborationAssetStore(options: {
  api: AssetApi;
  roomId: RoomId;
  /** End-to-end room key from the URL fragment; never from the backend. */
  roomKey: RoomKey;
  /** Authorization generation the session joined under. */
  authGeneration: number;
  /** Called with every batch of opened assets, for injection into the canvas. */
  onAssetsResolved: (files: readonly BinaryFileData[]) => void;
  /**
   * The room has images this session cannot open, and it has never opened one.
   *
   * Called at most once, and only under that second condition, which is what
   * separates the two failures a user cannot otherwise tell apart. "Not uploaded
   * yet" is retried and never reports here; "will not open" is final, and until
   * now looked identical — a canvas quietly short an image, with no message. One
   * successful open means the link does read this room, so a later failure is a
   * damaged or tampered asset and stays silent, exactly as a single bad realtime
   * frame does.
   */
  onAssetsUnreadable?: () => void;
  /**
   * Ids this client has given up on, batched. Retrying cannot produce these
   * images — the ciphertext will not open, the body disagrees with its record,
   * the local file is too large to publish, or the upload budget is spent — so
   * the canvas can say so instead of showing them as still loading.
   *
   * Separate from `onAssetsUnreadable`, which is one room-level statement about
   * the *link*. This is per image and carries no claim about the key: it is the
   * union of every terminal reason, which is exactly what "this picture is not
   * coming" means to the person looking at the canvas.
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
}): Promise<CollaborationAssetStore> {
  const {
    api,
    roomId,
    authGeneration,
    onAssetsResolved,
    onAssetsUnreadable,
    onAssetsUnavailable,
    onPublishRetryDue,
    scheduleTimeout = defaultScheduleTimeout,
    now = Date.now,
    fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, init),
  } = options;

  // Derived once per session: the key is bound to (room, generation, purpose),
  // and it is non-extractable, so it cannot end up in a log or an error payload.
  const codec = await createAssetCryptoCodec({
    roomKey: options.roomKey,
    roomId,
    authGeneration,
  });

  const controller = new AbortController();
  let destroyed = false;
  const isDestroyed = (): boolean => destroyed;

  /** Ids already handed to the canvas; never downloaded twice. */
  const resolved = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids no retry can help: unopenable, undecodable, or out of attempts. */
  const abandoned = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids this client has uploaded or seen in the room. */
  const available = createBoundedIdSet(MAX_TRACKED_IDS);
  const transfers = createTransferGate(MAX_CONCURRENT_TRANSFERS);

  /**
   * Ids given up on since the last report, awaiting one batched notification.
   *
   * Batched rather than reported per id because the caller turns this into a
   * scene write, and a late joiner with ten unopenable images must produce one
   * canvas update, not ten.
   */
  let unavailableIds: string[] = [];

  /**
   * The single place an id is given up on. Centralised so a terminal failure
   * cannot be added to `abandoned` without the canvas being told — the silent
   * variant of exactly this is what aggregate unreadable-room detection removes.
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

  const verdict = createUnreadableAssetVerdict({
    onAssetsUnreadable,
    isDestroyed,
  });

  const downloader = createAssetDownloader({
    resolve: api.resolve,
    roomId,
    authGeneration,
    codec,
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
    verdict,
    onAssetsResolved,
  });

  const publisher = createAssetPublisher({
    upload: api.upload,
    roomId,
    authGeneration,
    codec,
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
