import {
  encodeCollaborationAssetPayload,
  type AssetCryptoCodec,
} from "@drawstuff/collaboration/asset";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";

import type { AssetApi } from "@/lib/collab/asset-store";
import {
  createBoundedIdMap,
  type BoundedIdSet,
  type TransferGate,
} from "@/lib/collab/bounded-containers";
import { rateLimitRetryAfterMs } from "@/lib/collab/rate-limit";

/**
 * Publish half of the asset store: sealing, uploading, and the bounded retry
 * round for uploads that failed in a way a later attempt could fix.
 *
 * Everything here is driven through the context the store hands over — the
 * store owns the id verdicts (`resolved`/`abandoned`/`available`), the
 * transfer budget and the destroyed flag, because downloads share all three.
 */

/** Attempts per upload, counting the first. */
const MAX_PUBLISH_ATTEMPTS = 3;

export type AssetPublishContext = {
  upload: AssetApi["upload"];
  roomId: RoomId;
  authGeneration: number;
  codec: AssetCryptoCodec;
  signal: AbortSignal;
  isDestroyed(): boolean;
  now(): number;
  scheduleTimeout(run: () => void, delayMs: number): () => void;
  /** Backoff for attempt N; the store owns the pacing policy. */
  retryDelayMs(attempts: number): number;
  /** Cap for every id map, the room's own asset budget. */
  maxTrackedIds: number;
  /** Store-wide budget shared with downloads. */
  transfers: TransferGate;
  /** Ids already handed to the canvas; an upload's own bytes count. */
  resolved: BoundedIdSet;
  /** Ids no retry can help: unpublishable, or out of attempts. */
  abandoned: BoundedIdSet;
  /** Ids this client has uploaded or seen in the room. */
  available: BoundedIdSet;
  /** The single place an id is given up on; the store batches the report. */
  abandon(fileId: string): void;
  /** Flushes the batched given-up ids to the canvas, once per publish. */
  flushUnavailable(): void;
  /**
   * Asks the canvas to offer its files again after a failed upload.
   *
   * Inverted rather than retried from here on purpose: a retry has to use the
   * *current* scene, or it would re-upload an image the user has since deleted —
   * and holding the bytes for a retry would pin megabytes the engine already owns.
   */
  onPublishRetryDue?: () => void;
};

export type AssetPublisher = {
  publish(files: readonly BinaryFileData[]): Promise<void>;
  /** Cancels the retry timer and drops every upload claim and deadline. */
  dispose(): void;
};

export const createAssetPublisher = (
  context: AssetPublishContext,
): AssetPublisher => {
  const { codec, isDestroyed, now, available, abandoned, resolved, abandon } =
    context;

  const uploading = new Map<string, Promise<void>>();
  /**
   * Backoff state for uploads, mirroring the download side's `retrying`.
   *
   * The deadline has to live per file rather than only in the store's timer,
   * because the timer is not the only way back into `publish`: an ordinary scene
   * flush re-offers the whole current file set, so a user who simply keeps
   * drawing after a rate limit would otherwise re-attempt inside the window,
   * lose, and burn the bounded attempt budget until the image is abandoned.
   */
  const uploadRetrying = createBoundedIdMap<{
    attempts: number;
    notBefore: number;
  }>(context.maxTrackedIds);
  let cancelPublishRetry: (() => void) | undefined;
  /** When the armed publish retry is due; `0` when no timer is live. */
  let publishRetryDueAt = 0;

  /**
   * Asks the canvas to offer its files again once the deferred work is due.
   *
   * One timer for the store: several failed uploads share the round, and the round
   * re-reads the scene rather than replaying a captured file set, so an image the
   * user deleted in the meantime is simply not retried.
   *
   * The armed deadline is tracked, and a later one replaces it. Keeping the
   * first-armed timer would let an ordinary failure's short backoff pin the
   * round, dragging a rate-limited sibling back inside the window it was told to
   * wait out — and each of those losing attempts is one of three it gets.
   */
  const schedulePublishRetry = (dueAt: number): void => {
    if (isDestroyed() || !context.onPublishRetryDue) return;
    if (cancelPublishRetry && publishRetryDueAt >= dueAt) return;
    cancelPublishRetry?.();
    publishRetryDueAt = dueAt;
    cancelPublishRetry = context.scheduleTimeout(
      () => {
        cancelPublishRetry = undefined;
        publishRetryDueAt = 0;
        if (isDestroyed()) return;
        context.onPublishRetryDue?.();
      },
      Math.max(0, dueAt - now()),
    );
  };

  const publishOne = async (file: BinaryFileData): Promise<void> => {
    const encoded = encodeCollaborationAssetPayload({
      roomId: context.roomId,
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
    if (isDestroyed()) return;

    try {
      await context.upload({
        roomId: context.roomId,
        authGeneration: context.authGeneration,
        excalidrawFileId: file.id,
        cryptoVersion: codec.cryptoVersion,
        ciphertext: sealed.ciphertext,
        signal: context.signal,
      });
      available.add(file.id);
      // Our own bytes are already on the canvas: recording the id as resolved is
      // what stops this client from downloading the image it just uploaded.
      resolved.add(file.id);
      uploadRetrying.delete(file.id);
    } catch (error) {
      const attempts = (uploadRetrying.get(file.id)?.attempts ?? 0) + 1;
      if (attempts >= MAX_PUBLISH_ATTEMPTS) {
        abandon(file.id);
        uploadRetrying.delete(file.id);
        return;
      }
      // The server's reset deadline raises the local backoff, never lowers it.
      // One delay is computed and used for both the file's own deadline and the
      // timer, so the timer never fires before the file it was armed for is
      // eligible.
      const delayMs = Math.max(
        context.retryDelayMs(attempts),
        rateLimitRetryAfterMs(error) ?? 0,
      );
      uploadRetrying.set(file.id, { attempts, notBefore: now() + delayMs });
      // A timer, not "the next scene flush": a user who pastes an image and then
      // stops drawing produces no further flush, so a transient upload failure
      // would otherwise mean the image never reaches anybody. A rate limit is
      // one such transient failure — it consumes an attempt like any other, it
      // just cannot be retried before the server's window resets.
      schedulePublishRetry(now() + delayMs);
    }
  };

  async function publish(files: readonly BinaryFileData[]): Promise<void> {
    if (isDestroyed()) return;
    const at = now();
    const pending: BinaryFileData[] = [];
    /** Earliest deadline among files held back only by their own window. */
    let earliestDeferred: number | undefined;
    for (const file of files) {
      if (
        available.has(file.id) ||
        abandoned.has(file.id) ||
        uploading.has(file.id)
      ) {
        continue;
      }
      const state = uploadRetrying.get(file.id);
      // Every path back in respects the deadline, not just the timer — this is
      // the one that catches an ordinary scene flush. Being skipped is neither
      // an attempt nor a failure: nothing is counted and nothing is given up on,
      // so the bounded budget is still three real tries rather than three
      // refusals inside a window that was never going to accept them.
      if (state && state.notBefore > at) {
        if (
          earliestDeferred === undefined ||
          state.notBefore < earliestDeferred
        ) {
          earliestDeferred = state.notBefore;
        }
        continue;
      }
      pending.push(file);
    }
    // A round can defer everything it was offered. Those files are still owed a
    // retry, and if the caller stops drawing nothing else will ask for them.
    if (earliestDeferred !== undefined) schedulePublishRetry(earliestDeferred);
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
        return context.transfers
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
    context.flushUnavailable();
  }

  return {
    publish,
    dispose() {
      cancelPublishRetry?.();
      cancelPublishRetry = undefined;
      publishRetryDueAt = 0;
      uploading.clear();
      uploadRetrying.clear();
    },
  };
};
