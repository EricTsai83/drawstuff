import {
  createAssetCryptoCodec,
  decodeCollaborationAssetPayload,
  encodeCollaborationAssetPayload,
  EXCALIDRAW_FILE_ID_PATTERN,
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_LOOKUP_BATCH,
  MAX_ROOM_ASSETS_PER_GENERATION,
  type ASSET_CRYPTO_VERSION,
  type CollaborationAssetRecord,
} from "@drawstuff/collaboration/asset";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type {
  BinaryFileData,
  DataURL,
  FileId,
} from "@drawstuff/excalidraw-adapter/types";

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
 */

/** The backend surface this store needs; the tRPC client and the uploader satisfy it. */
export type AssetApi = {
  /**
   * `signal` is part of the contract rather than an option: leaving a room while a
   * lookup is in flight has to end the lookup, or the store's teardown would only
   * take effect whenever the network happened to answer.
   */
  resolve(
    input: { roomId: string; fileIds: string[] },
    signal: AbortSignal,
  ): Promise<{
    authGeneration: number;
    assets: CollaborationAssetRecord[];
    missing: string[];
  }>;
  /** Resolves when the ciphertext is stored and recorded; throws otherwise. */
  upload(input: {
    roomId: string;
    /** Generation the ciphertext was sealed for; the server refuses a mismatch. */
    authGeneration: number;
    excalidrawFileId: string;
    cryptoVersion: typeof ASSET_CRYPTO_VERSION;
    ciphertext: Uint8Array;
    signal: AbortSignal;
  }): Promise<void>;
};

export type CollaborationAssetStore = {
  /**
   * Seals and uploads every file the room does not have yet. Idempotent: a file
   * already published, in flight, or known to be in the room is skipped, so the
   * caller may hand over the whole current file set on every scene flush.
   */
  publish(files: readonly BinaryFileData[]): Promise<void>;
  /**
   * Fetches and opens the assets for ids the canvas is missing, handing the
   * results to `onAssetsResolved`. Concurrent calls for one id share a single
   * download.
   */
  request(fileIds: readonly string[]): Promise<void>;
  /** Aborts in-flight transfers, cancels the retry timer, and drops all state. */
  destroy(): void;
};

/**
 * Scheduled retries per download, counting the first attempt.
 *
 * Only the timer chain is bounded, not the id: an asset that is merely *not
 * uploaded yet* is never given up on permanently, because the peer that has it may
 * simply be slow. What stops it from becoming a request loop is the deadline —
 * after the chain ends, a further attempt happens only when new traffic asks for
 * the id again, and never sooner than `MAX_RETRY_DELAY_MS` after the last one.
 */
const MAX_SCHEDULED_DOWNLOAD_ATTEMPTS = 4;
/** Attempts per upload, counting the first. */
const MAX_PUBLISH_ATTEMPTS = 3;
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

/**
 * Insertion-ordered map with FIFO eviction; the oldest entry is always first.
 *
 * `onEvict` exists because a bounded map is only safe if everything derived from
 * it is dropped with it: an id whose retry state was evicted while something else
 * still listed it would look like an id with no deadline, which reads as "due
 * now".
 */
const createBoundedIdMap = <T>(
  limit: number,
  onEvict?: (id: string) => void,
) => {
  const entries = new Map<string, T>();
  return {
    get: (id: string): T | undefined => entries.get(id),
    has: (id: string): boolean => entries.has(id),
    set(id: string, value: T): void {
      if (!entries.has(id)) {
        while (entries.size >= limit) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
          onEvict?.(oldest.value);
        }
      }
      entries.set(id, value);
    },
    delete(id: string): void {
      entries.delete(id);
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
};

type BoundedIdSet = {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
  readonly size: number;
};

const createBoundedIdSet = (limit: number): BoundedIdSet => {
  const ids = createBoundedIdMap<true>(limit);
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.set(id, true);
    },
    delete: (id) => {
      ids.delete(id);
    },
    get size() {
      return ids.size;
    },
  };
};

/**
 * Store-wide transfer budget.
 *
 * A slot is either held by a running transfer or handed directly to the next
 * waiter, so the count can neither drift nor be exceeded by callers that overlap.
 */
const createTransferGate = (limit: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
};

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

/**
 * Reads a response body without ever holding more than `maxBytes`.
 *
 * `arrayBuffer()` would decide the size after materializing it, which is the one
 * thing a bound has to prevent — the record's declared length is what this trusts,
 * and a body that exceeds it is cancelled mid-stream.
 */
const readBoundedBody = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const body = response.body;
  if (!body) {
    // No streaming body (a non-streaming fetch implementation): the declared
    // length is still enforced, just after the fact.
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength <= maxBytes ? buffer : null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Per-id outcome of one transfer attempt. */
type TransferOutcome =
  | "resolved"
  | "retry"
  /** Retrying cannot fix it, and the reason is not the room key. */
  | "abandon"
  /**
   * Abandoned because the ciphertext would not open under this room's derived
   * key — a wrong key, a tampered body, or an envelope version this client does
   * not implement. Handled exactly like `abandon`; it is split out only so the
   * store can tell "this link cannot read the room's images" from every other
   * reason an image never arrives.
   */
  | "undecryptable";

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

  /** Ids already handed to the canvas; never downloaded twice. */
  const resolved = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids no retry can help: unopenable, undecodable, or out of attempts. */
  const abandoned = createBoundedIdSet(MAX_TRACKED_IDS);
  /** Ids this client has uploaded or seen in the room. */
  const available = createBoundedIdSet(MAX_TRACKED_IDS);
  /**
   * One shared download per id, so concurrent requests do not duplicate work.
   * Bounded by the transfer gate rather than by a cap: an entry exists only while
   * a transfer is claimed, so this cannot outgrow what is in flight.
   */
  const downloading = new Map<string, Promise<void>>();
  const uploading = new Map<string, Promise<void>>();
  let cancelRetry: (() => void) | undefined;
  /**
   * Ids awaiting a scheduled retry. Never outlives `retrying`: an entry evicted
   * there is dropped here too, or it would sit in the queue with no deadline —
   * which the timer would read as "due now" and re-request in a tight loop.
   */
  let retryQueue = new Set<string>();
  /** Backoff state for ids that failed in a way a later attempt could fix. */
  const retrying = createBoundedIdMap<{ attempts: number; notBefore: number }>(
    MAX_TRACKED_IDS,
    (evicted) => retryQueue.delete(evicted),
  );
  const uploadAttempts = createBoundedIdMap<number>(MAX_TRACKED_IDS);
  const transfers = createTransferGate(MAX_CONCURRENT_TRANSFERS);

  let cancelPublishRetry: (() => void) | undefined;

  /**
   * Aggregate evidence for `onAssetsUnreadable`, mirroring the realtime path's
   * verdict (`TransportSubscriber.onRoomUnreadable`): one flag for "this link has
   * opened something in this room", one for "already said so".
   *
   * The evidence is store-wide and so is the moment it is judged. Judging a
   * batch on its own would be wrong twice over: a batch's records open
   * concurrently, and — because `request` may be called again while an earlier
   * one is still running — a *second* batch holding the room's only readable
   * asset can still be in flight when the first one finishes with nothing. Either
   * would report an unreadable room to a link that reads it fine, which is
   * exactly the "one damaged image" case that has to stay silent.
   */
  let openedAnyAsset = false;
  let reportedUnreadableAssets = false;
  /**
   * A flag, not a tally: the only question ever asked of it is whether *any*
   * evidence exists, so counting every unopenable record a room ever serves would
   * be an unbounded number kept for nothing.
   */
  let sawUndecryptableAsset = false;
  /**
   * Lookup batches still running, and the id of the last one started. A batch's
   * `Promise.all` settles before its `finally`, so counting whole batches also
   * covers every record inside one — no per-record bookkeeping is needed.
   */
  let assetFetchesInFlight = 0;
  let lastAssetFetchId = 0;
  /**
   * The batches the armed evidence is waiting on: those already running when the
   * first undecryptable record appeared, and how many are left. `-1` means no
   * evidence yet.
   *
   * A cohort rather than "no batch is running", for the same reason the realtime
   * verdict uses one: a room whose images keep being requested never goes quiet,
   * and waiting for that would mean the user is told nothing for as long as the
   * room stays busy.
   */
  let unreadableFenceFetchId = -1;
  let unreadableFenceRemaining = 0;

  /** Arms the evidence, fencing it to the lookups already in flight. */
  const noteUndecryptableAsset = (): void => {
    if (sawUndecryptableAsset || openedAnyAsset || reportedUnreadableAssets) {
      return;
    }
    sawUndecryptableAsset = true;
    // The batch that found it is itself still running, so its own teardown is
    // what reports when no other lookup was open.
    unreadableFenceFetchId = lastAssetFetchId;
    unreadableFenceRemaining = assetFetchesInFlight;
  };

  /**
   * Retires one batch from the armed cohort and reports once it has drained.
   *
   * Called from every batch's teardown, so a readable asset that lands in a
   * concurrent batch cancels the report permanently through `openedAnyAsset`.
   */
  const settleUnreadableAssets = (fetchId: number): void => {
    if (!sawUndecryptableAsset) return;
    if (fetchId <= unreadableFenceFetchId) unreadableFenceRemaining -= 1;
    if (unreadableFenceRemaining > 0) return;
    if (destroyed || openedAnyAsset || reportedUnreadableAssets) return;
    reportedUnreadableAssets = true;
    onAssetsUnreadable?.();
  };

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

  const forget = (fileId: string): void => {
    retrying.delete(fileId);
    retryQueue.delete(fileId);
  };

  /**
   * Records a retryable failure and, while the scheduled chain lasts, queues the
   * id for another attempt.
   *
   * Past the chain the deadline stays and nothing is queued — the id is then only
   * re-requested if new traffic references it, which is what keeps a genuinely
   * absent asset from being either given up on or polled for.
   */
  const deferRetry = (fileId: string): void => {
    if (destroyed) return;
    const attempts = (retrying.get(fileId)?.attempts ?? 0) + 1;
    retrying.set(fileId, {
      attempts,
      notBefore: now() + retryDelayMs(attempts),
    });
    if (attempts < MAX_SCHEDULED_DOWNLOAD_ATTEMPTS) retryQueue.add(fileId);
  };

  /**
   * Arms the timer for whatever the last request deferred.
   *
   * Called once a request has released its claims, and that ordering is the whole
   * point: a timer armed mid-request could fire while the request that scheduled
   * it still holds the id, and the retry would be deduplicated against it — losing
   * the chain and leaving the asset waiting for unrelated traffic.
   *
   * One timer for the whole queue rather than one per id: a room that gains ten
   * images at once must produce one retry round, not ten. It fires at the earliest
   * deadline and takes only the ids that are actually due — jitter means the rest
   * of the queue is a few hundred milliseconds behind, and draining them here
   * would hand them to `request`, which filters them out and would then have
   * nothing left to re-arm from.
   */
  const armRetryTimer = (): void => {
    if (destroyed || cancelRetry) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const fileId of [...retryQueue]) {
      const state = retrying.get(fileId);
      // No state means the entry was evicted: it is not owed a retry, and
      // treating it as due would make this a zero-delay loop.
      if (!state) {
        retryQueue.delete(fileId);
        continue;
      }
      if (state.notBefore < earliest) earliest = state.notBefore;
    }
    if (retryQueue.size === 0) return;
    const delay = Math.max(0, earliest - now());
    cancelRetry = scheduleTimeout(() => {
      cancelRetry = undefined;
      if (destroyed) return;
      const at = now();
      const due: string[] = [];
      for (const fileId of [...retryQueue]) {
        const state = retrying.get(fileId);
        if (!state) {
          retryQueue.delete(fileId);
          continue;
        }
        if (state.notBefore > at) continue;
        due.push(fileId);
        retryQueue.delete(fileId);
      }
      // Whatever stayed queued gets its own timer as soon as this request lets go.
      void request(due);
      if (due.length === 0) armRetryTimer();
    }, delay);
  };

  const openRecord = async (
    record: CollaborationAssetRecord,
  ): Promise<{ outcome: TransferOutcome; file?: BinaryFileData }> => {
    // A record sealed under an envelope version this client does not implement is
    // not a transient failure: nothing here can ever open it. Counted as
    // undecryptable rather than merely abandoned — a version bump makes every
    // pre-existing asset in the room unopenable at once, which is the "room full
    // of images this link cannot show" case the user has to be told about.
    if (record.cryptoVersion !== codec.cryptoVersion) {
      return { outcome: "undecryptable" };
    }
    const limit = Math.min(record.byteLength, MAX_ASSET_CIPHERTEXT_BYTES);

    let ciphertext: Uint8Array | null;
    try {
      const response = await fetchImpl(record.url, {
        signal: controller.signal,
      });
      if (!response.ok) return { outcome: "retry" };
      ciphertext = await readBoundedBody(response, limit);
    } catch {
      // Abort included: the caller is gone, and `destroyed` stops the retry.
      return { outcome: "retry" };
    }
    // A body that disagrees with its record is not this asset, whichever is
    // wrong; a retry would fetch the same bytes. Not `undecryptable`: nothing was
    // asked of the key here, so it is no evidence about the link.
    if (!ciphertext || ciphertext.byteLength !== record.byteLength) {
      return { outcome: "abandon" };
    }

    const opened = await codec.open({
      excalidrawFileId: record.excalidrawFileId,
      ciphertext,
    });
    if (!opened.ok) return { outcome: "undecryptable" };
    // Latched on the *open*, not on the resolve: authentication passing is what
    // proves this link reads this room, whatever the plaintext then turns out to
    // contain.
    openedAnyAsset = true;

    // Authentication already succeeded, so the key is right and the room is
    // readable — a payload this client cannot parse is a peer's protocol
    // violation, and it stays as silent as it was.
    const decoded = decodeCollaborationAssetPayload(opened.plaintext, {
      roomId,
      excalidrawFileId: record.excalidrawFileId,
    });
    if (!decoded.ok) return { outcome: "abandon" };

    return {
      outcome: "resolved",
      file: {
        id: decoded.payload.excalidrawFileId as FileId,
        dataURL: decoded.payload.dataUrl as DataURL,
        mimeType: decoded.payload.mimeType,
        // The room is the origin of these bytes for this client, so the
        // timestamps describe *this* retrieval. Copying a sender's clock would
        // put another machine's time into local file bookkeeping.
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    };
  };

  /**
   * Fetches a batch of ids, and only ids nothing else is already fetching.
   *
   * Ids skipped because a download is in flight are not dropped: the caller waits
   * for that download and asks again for whatever it did not deliver. Without that
   * step a request arriving mid-download would vanish — and since the download in
   * progress has already recorded its own retry, nothing would ever come back to
   * it.
   */
  async function request(fileIds: readonly string[]): Promise<void> {
    if (destroyed) return;
    const at = now();
    const unique = [...new Set(fileIds)].sort();
    const needed: string[] = [];
    for (const fileId of unique) {
      if (resolved.has(fileId) || abandoned.has(fileId)) continue;
      // Validated per id, not per batch. These ids come off remote elements, and
      // the lookup API rejects a whole batch containing one malformed id — so a
      // single bad `fileId` on somebody's element would keep every other image in
      // the same message from ever loading.
      if (!EXCALIDRAW_FILE_ID_PATTERN.test(fileId)) {
        abandon(fileId);
        continue;
      }
      needed.push(fileId);
    }
    const joinable = needed.filter((fileId) => downloading.has(fileId));
    const wanted: string[] = [];
    for (const fileId of needed) {
      if (downloading.has(fileId)) continue;
      const state = retrying.get(fileId);
      // Rate limit per id: traffic that keeps naming an asset the room does not
      // have must not turn into a lookup per message. An id that is merely early
      // stays queued so its own deadline still gets a timer.
      if (state && state.notBefore > at) {
        if (state.attempts < MAX_SCHEDULED_DOWNLOAD_ATTEMPTS) {
          retryQueue.add(fileId);
        }
        continue;
      }
      wanted.push(fileId);
    }

    try {
      if (wanted.length > 0) await fetchBatch(wanted);
      if (joinable.length === 0 || destroyed) return;

      await Promise.all(
        joinable
          .map((fileId) => downloading.get(fileId))
          .filter((claim): claim is Promise<void> => claim !== undefined),
      );
      if (destroyed) return;
      const unresolved = joinable.filter(
        (fileId) =>
          !resolved.has(fileId) &&
          !abandoned.has(fileId) &&
          !downloading.has(fileId),
      );
      // Terminates: every id is now resolved, abandoned, rate limited, or claimed
      // by a newer download, and each of those cases filters it out above.
      if (unresolved.length > 0) await request(unresolved);
    } finally {
      // Armed here rather than inside `fetchBatch` so every path re-arms — a
      // request that turned out to have nothing to fetch may still have queued an
      // id whose deadline has not arrived.
      armRetryTimer();
      // One canvas update per request rather than per id or per batch: a late
      // joiner with ten unopenable images must not produce ten scene writes.
      flushUnavailable();
    }
  }

  async function fetchBatch(wanted: readonly string[]): Promise<void> {
    // Claimed before the first await so a second `request` in the same tick joins
    // this download instead of starting another.
    let settle = (): void => undefined;
    const claim = new Promise<void>((resolve) => {
      settle = resolve;
    });
    for (const fileId of wanted) downloading.set(fileId, claim);

    assetFetchesInFlight += 1;
    lastAssetFetchId += 1;
    const fetchId = lastAssetFetchId;
    try {
      for (
        let offset = 0;
        offset < wanted.length;
        offset += MAX_ASSET_LOOKUP_BATCH
      ) {
        const batch = wanted.slice(offset, offset + MAX_ASSET_LOOKUP_BATCH);
        let lookup: Awaited<ReturnType<AssetApi["resolve"]>>;
        try {
          lookup = await api.resolve(
            { roomId, fileIds: batch },
            controller.signal,
          );
        } catch {
          for (const fileId of batch) deferRetry(fileId);
          continue;
        }
        if (destroyed) return;
        // The generation the records belong to is the one the key was derived
        // for; a mismatch means the room rotated under us and these bytes are not
        // ours to open. The session is torn down on rotation, so this only guards
        // the window before that happens.
        if (lookup.authGeneration !== authGeneration) {
          for (const fileId of batch) abandon(fileId);
          continue;
        }

        for (const fileId of lookup.missing) deferRetry(fileId);

        const opened: BinaryFileData[] = [];
        await Promise.all(
          lookup.assets.map((record) =>
            // Every download waits for a slot in the store-wide budget, so a
            // second overlapping request cannot double the bytes in memory.
            transfers.run(async () => {
              available.add(record.excalidrawFileId);
              const result = await openRecord(record);
              if (destroyed) return;
              if (result.outcome === "resolved" && result.file) {
                resolved.add(record.excalidrawFileId);
                forget(record.excalidrawFileId);
                opened.push(result.file);
                return;
              }
              if (result.outcome === "retry") {
                deferRetry(record.excalidrawFileId);
                return;
              }
              // Both terminal outcomes drop the asset the same way; only the
              // evidence flag distinguishes them, and it is judged store-wide
              // once the armed cohort has drained (`settleUnreadableAssets`).
              if (result.outcome === "undecryptable") noteUndecryptableAsset();
              abandon(record.excalidrawFileId);
              forget(record.excalidrawFileId);
            }),
          ),
        );
        if (destroyed) return;
        // One injection per batch: `addFiles` triggers an engine re-render, and a
        // late joiner loading ten images must not cause ten of them.
        if (opened.length > 0) onAssetsResolved(opened);
      }
    } finally {
      for (const fileId of wanted) {
        if (downloading.get(fileId) === claim) downloading.delete(fileId);
      }
      assetFetchesInFlight -= 1;
      // Judged only once the armed cohort has drained, so a readable asset in a
      // lookup that was already running still gets to prove the link opens this
      // room.
      settleUnreadableAssets(fetchId);
      settle();
    }
  }

  const publishOne = async (file: BinaryFileData): Promise<void> => {
    const encoded = encodeCollaborationAssetPayload({
      roomId,
      excalidrawFileId: file.id,
      mimeType: file.mimeType,
      dataUrl: file.dataURL,
    });
    // An oversize image or an unsupported type cannot become publishable by
    // retrying, and the element referencing it still syncs — peers simply do not
    // render it.
    if (!encoded.ok) {
      abandon(file.id);
      return;
    }
    const sealed = await codec.seal({
      excalidrawFileId: file.id,
      plaintext: encoded.bytes,
    });
    if (!sealed.ok) {
      abandon(file.id);
      return;
    }
    if (destroyed) return;

    try {
      await api.upload({
        roomId,
        authGeneration,
        excalidrawFileId: file.id,
        cryptoVersion: codec.cryptoVersion,
        ciphertext: sealed.ciphertext,
        signal: controller.signal,
      });
      available.add(file.id);
      // Our own bytes are already on the canvas: recording the id as resolved is
      // what stops this client from downloading the image it just uploaded.
      resolved.add(file.id);
      uploadAttempts.delete(file.id);
    } catch {
      const attempts = (uploadAttempts.get(file.id) ?? 0) + 1;
      if (attempts >= MAX_PUBLISH_ATTEMPTS) {
        abandon(file.id);
        uploadAttempts.delete(file.id);
        return;
      }
      uploadAttempts.set(file.id, attempts);
      // A timer, not "the next scene flush": a user who pastes an image and then
      // stops drawing produces no further flush, so a transient upload failure
      // would otherwise mean the image never reaches anybody.
      schedulePublishRetry(attempts);
    }
  };

  /**
   * Asks the canvas to offer its files again after a failed upload.
   *
   * One timer for the store: several failed uploads share the round, and the round
   * re-reads the scene rather than replaying a captured file set, so an image the
   * user deleted in the meantime is simply not retried.
   */
  const schedulePublishRetry = (attempts: number): void => {
    if (destroyed || cancelPublishRetry || !onPublishRetryDue) return;
    cancelPublishRetry = scheduleTimeout(() => {
      cancelPublishRetry = undefined;
      if (destroyed) return;
      onPublishRetryDue();
    }, retryDelayMs(attempts));
  };

  async function publish(files: readonly BinaryFileData[]): Promise<void> {
    if (destroyed) return;
    const pending = files.filter(
      (file) =>
        !available.has(file.id) &&
        !abandoned.has(file.id) &&
        !uploading.has(file.id),
    );
    if (pending.length === 0) return;

    // Claimed and released *per file*, not per batch. A batch-wide claim would
    // still be held by a slow sibling when the retry timer for a fast failure
    // fires, and the retry would skip the very file it was scheduled for.
    await Promise.all(
      pending.map((file) => {
        let settle = (): void => undefined;
        const claim = new Promise<void>((resolve) => {
          settle = resolve;
        });
        uploading.set(file.id, claim);
        // Uploads share the download budget: peak memory is four transfers
        // whatever mix they are.
        return transfers
          .run(() => publishOne(file))
          .finally(() => {
            if (uploading.get(file.id) === claim) uploading.delete(file.id);
            settle();
          });
      }),
    );
    // The local user's own images can be terminal too — too large to publish, an
    // unsupported type, or an upload budget that ran out — and until now that was
    // as silent as an unopenable download.
    flushUnavailable();
  }

  return {
    publish,
    request,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelRetry?.();
      cancelRetry = undefined;
      cancelPublishRetry?.();
      cancelPublishRetry = undefined;
      retryQueue = new Set();
      // Aborts fetches, uploads and lookups alike: every network call this store
      // makes carries this signal.
      controller.abort();
      downloading.clear();
      uploading.clear();
      retrying.clear();
      uploadAttempts.clear();
    },
  };
}
