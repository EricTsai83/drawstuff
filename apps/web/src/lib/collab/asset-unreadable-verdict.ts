/**
 * Aggregate evidence for "this link cannot read the room's images", mirroring
 * the realtime path's verdict (`TransportSubscriber.onRoomUnreadable`): one
 * flag for "this link has opened something in this room", one for "already
 * said so".
 *
 * The evidence is store-wide and so is the moment it is judged. Judging a
 * batch on its own would be wrong twice over: a batch's records open
 * concurrently, and — because a request may be issued again while an earlier
 * one is still running — a *second* batch holding the room's only readable
 * asset can still be in flight when the first one finishes with nothing. Either
 * would report an unreadable room to a link that reads it fine, which is
 * exactly the "one damaged image" case that has to stay silent.
 *
 * Why a fence and not "no batch is running": a room whose images keep being
 * requested never goes quiet, and waiting for that would mean the user is told
 * nothing for as long as the room stays busy. So the first undecryptable
 * record arms a *cohort* — the lookups already in flight at that moment — and
 * the report fires once that cohort has drained, however busy the store still
 * is with newer lookups.
 */
export type UnreadableAssetVerdict = {
  /** Registers a lookup batch; returns the id its teardown must settle with. */
  beginFetch(): number;
  /**
   * A record authenticated under this room's key. Latched on the *open*, not on
   * the resolve: authentication passing is what proves this link reads this
   * room, whatever the plaintext then turns out to contain. Cancels the report
   * permanently.
   */
  noteOpenedAsset(): void;
  /** Arms the evidence, fencing it to the lookups already in flight. */
  noteUndecryptableAsset(): void;
  /**
   * Retires one batch from the armed cohort and reports once it has drained.
   *
   * Called from every batch's teardown, so a readable asset that lands in a
   * concurrent batch cancels the report permanently through `noteOpenedAsset`.
   */
  settleFetch(fetchId: number): void;
};

export const createUnreadableAssetVerdict = (options: {
  /** Reported at most once; see the module doc for when. */
  onAssetsUnreadable?: () => void;
  /** A destroyed store must not report, whatever was armed. */
  isDestroyed: () => boolean;
}): UnreadableAssetVerdict => {
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
   */
  let unreadableFenceFetchId = -1;
  let unreadableFenceRemaining = 0;

  return {
    beginFetch() {
      assetFetchesInFlight += 1;
      lastAssetFetchId += 1;
      return lastAssetFetchId;
    },
    noteOpenedAsset() {
      openedAnyAsset = true;
    },
    noteUndecryptableAsset() {
      if (sawUndecryptableAsset || openedAnyAsset || reportedUnreadableAssets) {
        return;
      }
      sawUndecryptableAsset = true;
      // The batch that found it is itself still running, so its own teardown is
      // what reports when no other lookup was open.
      unreadableFenceFetchId = lastAssetFetchId;
      unreadableFenceRemaining = assetFetchesInFlight;
    },
    settleFetch(fetchId) {
      assetFetchesInFlight -= 1;
      if (!sawUndecryptableAsset) return;
      if (fetchId <= unreadableFenceFetchId) unreadableFenceRemaining -= 1;
      if (unreadableFenceRemaining > 0) return;
      if (options.isDestroyed() || openedAnyAsset || reportedUnreadableAssets) {
        return;
      }
      reportedUnreadableAssets = true;
      options.onAssetsUnreadable?.();
    },
  };
};
