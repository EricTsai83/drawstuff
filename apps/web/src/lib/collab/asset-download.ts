import {
  decodeCollaborationAssetPayload,
  EXCALIDRAW_FILE_ID_PATTERN,
  MAX_ASSET_CIPHERTEXT_BYTES,
  MAX_ASSET_LOOKUP_BATCH,
  type AssetCryptoCodec,
  type CollaborationAssetRecord,
} from "@drawstuff/collaboration/asset";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type {
  BinaryFileData,
  DataURL,
  FileId,
} from "@drawstuff/excalidraw-adapter/types";

import type { AssetApi } from "@/lib/collab/asset-store";
import type { UnreadableAssetVerdict } from "@/lib/collab/asset-unreadable-verdict";
import { rateLimitRetryAfterMs } from "@/lib/collab/rate-limit";
import {
  createBoundedIdMap,
  readBoundedBody,
  type BoundedIdSet,
  type TransferGate,
} from "@/lib/collab/bounded-containers";

/**
 * Download half of the asset store: lookup batches, bounded ciphertext
 * fetches, opening, and the retry chain for assets that are merely not
 * uploaded yet.
 *
 * Everything here is driven through the context the store hands over — the
 * store owns the id verdicts (`resolved`/`abandoned`/`available`), the
 * transfer budget and the destroyed flag, because uploads share all three.
 */

/**
 * Scheduled retries per download, counting the first attempt.
 *
 * Only the timer chain is bounded, not the id: an asset that is merely *not
 * uploaded yet* is never given up on permanently, because the peer that has it may
 * simply be slow. What stops it from becoming a request loop is the deadline —
 * after the chain ends, a further attempt happens only when new traffic asks for
 * the id again, and never sooner than the backoff ceiling after the last one.
 */
const MAX_SCHEDULED_DOWNLOAD_ATTEMPTS = 4;

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

type AssetDownloadContext = {
  resolve: AssetApi["resolve"];
  roomId: RoomId;
  authGeneration: number;
  codec: AssetCryptoCodec;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  isDestroyed: () => boolean;
  now: () => number;
  scheduleTimeout: (run: () => void, delayMs: number) => () => void;
  /** Backoff for attempt N; the store owns the pacing policy. */
  retryDelayMs: (attempts: number) => number;
  /** Cap for every id map, the room's own asset budget. */
  maxTrackedIds: number;
  /** Store-wide budget shared with uploads. */
  transfers: TransferGate;
  /** Ids already handed to the canvas; never downloaded twice. */
  resolved: BoundedIdSet;
  /** Ids no retry can help: unopenable, undecodable, or out of attempts. */
  abandoned: BoundedIdSet;
  /** Ids this client has uploaded or seen in the room. */
  available: BoundedIdSet;
  /** The single place an id is given up on; the store batches the report. */
  abandon: (fileId: string) => void;
  /** Flushes the batched given-up ids to the canvas, once per request. */
  flushUnavailable: () => void;
  verdict: UnreadableAssetVerdict;
  /** Called with every batch of opened assets, for injection into the canvas. */
  onAssetsResolved: (files: readonly BinaryFileData[]) => void;
};

type AssetDownloader = {
  request: (fileIds: readonly string[]) => Promise<void>;
  /** Cancels the retry timer and drops every download claim and deadline. */
  dispose: () => void;
};

export const createAssetDownloader = (
  context: AssetDownloadContext,
): AssetDownloader => {
  const {
    codec,
    fetchImpl,
    isDestroyed,
    now,
    resolved,
    abandoned,
    available,
    abandon,
    verdict,
  } = context;

  /**
   * One shared download per id, so concurrent requests do not duplicate work.
   * Bounded by the transfer gate rather than by a cap: an entry exists only while
   * a transfer is claimed, so this cannot outgrow what is in flight.
   */
  const downloading = new Map<string, Promise<void>>();
  let cancelRetry: (() => void) | undefined;
  /**
   * Ids awaiting a scheduled retry. Never outlives `retrying`: an entry evicted
   * there is dropped here too, or it would sit in the queue with no deadline —
   * which the timer would read as "due now" and re-request in a tight loop.
   */
  let retryQueue = new Set<string>();
  /** Backoff state for ids that failed in a way a later attempt could fix. */
  const retrying = createBoundedIdMap<{ attempts: number; notBefore: number }>(
    context.maxTrackedIds,
    (evicted) => retryQueue.delete(evicted),
  );

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
   *
   * `notBeforeMs` is the server's own reset deadline when the failure was a
   * rate limit. It raises the delay and never lowers it: the local backoff is
   * this client's politeness, the server's deadline is a fact about a shared
   * budget, and retrying before it can only spend a token that was going to be
   * refused anyway. The attempt still counts, so the bounded chain is unchanged.
   */
  const deferRetry = (fileId: string, notBeforeMs = 0): void => {
    if (isDestroyed()) return;
    const attempts = (retrying.get(fileId)?.attempts ?? 0) + 1;
    retrying.set(fileId, {
      attempts,
      notBefore: now() + Math.max(context.retryDelayMs(attempts), notBeforeMs),
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
    if (isDestroyed() || cancelRetry) return;
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
    cancelRetry = context.scheduleTimeout(() => {
      cancelRetry = undefined;
      if (isDestroyed()) return;
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
        signal: context.signal,
      });
      if (!response.ok) return { outcome: "retry" };
      ciphertext = await readBoundedBody(response, limit);
    } catch {
      // Abort included: the caller is gone, and the destroyed flag stops the retry.
      return { outcome: "retry" };
    }
    // A body that disagrees with its record is not this asset, whichever is
    // wrong; a retry would fetch the same bytes. Not `undecryptable`: nothing was
    // asked of the key here, so it is no evidence about the link.
    if (ciphertext?.byteLength !== record.byteLength) {
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
    verdict.noteOpenedAsset();

    // Authentication already succeeded, so the key is right and the room is
    // readable — a payload this client cannot parse is a peer's protocol
    // violation, and it stays as silent as it was.
    const decoded = decodeCollaborationAssetPayload(opened.plaintext, {
      roomId: context.roomId,
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
    if (isDestroyed()) return;
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
      if (joinable.length === 0 || isDestroyed()) return;

      await Promise.all(
        joinable
          .map((fileId) => downloading.get(fileId))
          .filter((claim): claim is Promise<void> => claim !== undefined),
      );
      if (isDestroyed()) return;
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
      context.flushUnavailable();
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

    const fetchId = verdict.beginFetch();
    try {
      for (
        let offset = 0;
        offset < wanted.length;
        offset += MAX_ASSET_LOOKUP_BATCH
      ) {
        const batch = wanted.slice(offset, offset + MAX_ASSET_LOOKUP_BATCH);
        let lookup: Awaited<ReturnType<AssetApi["resolve"]>>;
        try {
          lookup = await context.resolve(
            { roomId: context.roomId, fileIds: batch },
            context.signal,
          );
        } catch (error) {
          // A refused lookup is transient whatever the reason, so the existing
          // bounded chain already covers it; a rate limit only moves the
          // deadline out to the window the server named.
          const notBefore = rateLimitRetryAfterMs(error) ?? 0;
          for (const fileId of batch) deferRetry(fileId, notBefore);
          continue;
        }
        if (isDestroyed()) return;
        // The generation the records belong to is the one the key was derived
        // for; a mismatch means the room rotated under us and these bytes are not
        // ours to open. The session is torn down on rotation, so this only guards
        // the window before that happens.
        if (lookup.authGeneration !== context.authGeneration) {
          for (const fileId of batch) abandon(fileId);
          continue;
        }

        for (const fileId of lookup.missing) deferRetry(fileId);

        const opened: BinaryFileData[] = [];
        await Promise.all(
          lookup.assets.map((record) =>
            // Every download waits for a slot in the store-wide budget, so a
            // second overlapping request cannot double the bytes in memory.
            context.transfers.run(async () => {
              available.add(record.excalidrawFileId);
              const result = await openRecord(record);
              if (isDestroyed()) return;
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
              // once the armed cohort has drained (`verdict.settleFetch`).
              if (result.outcome === "undecryptable") {
                verdict.noteUndecryptableAsset();
              }
              abandon(record.excalidrawFileId);
              forget(record.excalidrawFileId);
            }),
          ),
        );
        if (isDestroyed()) return;
        // One injection per batch: `addFiles` triggers an engine re-render, and a
        // late joiner loading ten images must not cause ten of them.
        if (opened.length > 0) context.onAssetsResolved(opened);
      }
    } finally {
      for (const fileId of wanted) {
        if (downloading.get(fileId) === claim) downloading.delete(fileId);
      }
      // Judged only once the armed cohort has drained, so a readable asset in a
      // lookup that was already running still gets to prove the link opens this
      // room.
      verdict.settleFetch(fetchId);
      settle();
    }
  }

  return {
    request,
    dispose() {
      cancelRetry?.();
      cancelRetry = undefined;
      retryQueue = new Set();
      downloading.clear();
      retrying.clear();
    },
  };
};
