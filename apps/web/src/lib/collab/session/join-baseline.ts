import {
  createJoinBarrier,
  type JoinBarrier,
  type JoinBarrierOptions,
} from "@drawstuff/collaboration/join-barrier";
import type { createOfflineChangeQueue } from "@drawstuff/collaboration/offline-queue";
import type {
  createRecoveryMachine,
  UnrecoverableReason,
} from "@drawstuff/collaboration/recovery";
import type {
  SceneMessage,
  SyncedElement,
} from "@drawstuff/collaboration/protocol";

import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";
import type { PublishOutcome } from "@/lib/collab/session/scene-publisher";
import type { SessionContext } from "@/lib/collab/session/session-context";

/**
 * How the joining client obtained (or failed to obtain) the room's scene.
 * Reported once per connection so the UI can distinguish "this room is empty"
 * from "this link cannot read this room", which look identical on the canvas.
 */
export type BaselineOutcome =
  /** An elected peer answered with a full-scene snapshot. */
  | "peer"
  /** The stored baseline won the race with the peers (or there were none). */
  | "durable-snapshot"
  /** The room genuinely has no stored state yet. */
  | "empty"
  /**
   * A durable snapshot exists but this session cannot open it — a link with the
   * wrong key, or a generation rotated after the link was shared. Terminal for
   * the baseline: the session stays connected and converges from live peers, but
   * the room's stored history is unreadable here, and this client will not
   * replace it.
   */
  | "unreadable-snapshot"
  /**
   * The stored baseline could not be fetched at all. Unlike the above this is
   * transient, but the consequence for this session is the same: it does not
   * know the baseline, so it must not overwrite it.
   */
  | "snapshot-unavailable";

/**
 * What the join established about the room's own state, which is what decides
 * how much of the local canvas may be published once the barrier opens.
 *
 * Separate from `BaselineOutcome` because the outcomes group differently for this
 * question than for the user-facing one: a peer snapshot and an empty room are
 * both "known", and a failed fetch and an expired deadline are both "unknown".
 */
export type BaselineKnowledge =
  /** The room's state was obtained — possibly empty, which is still knowledge. */
  | "known"
  /**
   * Nothing was obtained. The whole canvas is published: it is the only state
   * this client can vouch for, and a full snapshot converges from anywhere.
   */
  | "unknown"
  /**
   * The room has state this client cannot decrypt. Nothing is published — this
   * canvas is not the room's scene, and sending it would claim that it is.
   */
  | "unreadable";

/** The durable-revision bookkeeping the baseline load feeds; the cadence owns it. */
export type SnapshotBaselineSink = {
  adoptLoaded(revision: number): void;
  adoptEmpty(): void;
  markUnknown(): void;
};

export type JoinBaselineGate = {
  /** Opens the barrier for a new connection and races the baseline sources. */
  openBarrier(epoch: number): void;
  hasBarrier(): boolean;
  /**
   * The barrier's view of an inbound scene message; true when it consumed it —
   * either held behind the barrier or claimed as the peer baseline.
   */
  interceptSceneMessage(message: SceneMessage, byteLength: number): boolean;
  /**
   * Reads the durable baseline, merges it into the canvas, and — if it is the
   * first baseline to arrive — opens the join barrier with it.
   */
  loadDurableBaseline(epoch: number): Promise<void>;
  /** Disposes the barrier and cancels the deadline; teardown and disconnects. */
  dispose(): void;
};

/**
 * The join exchange: the barrier that holds inbound scene traffic until a
 * baseline lands, the race between the durable snapshot and the elected peer's
 * reply, and the publish that pays this client's debt to the room afterwards.
 */
export const createJoinBaselineGate = (options: {
  context: SessionContext;
  /**
   * Durable baseline for this room generation. Absent means the session runs on
   * live peers alone — used by tests that exercise peer sync in isolation.
   */
  snapshotStore: CollaborationSnapshotStore | undefined;
  joinBarrierOptions: JoinBarrierOptions | undefined;
  joinBaselineTimeoutMs: number;
  offlineQueue: ReturnType<typeof createOfflineChangeQueue>;
  recovery: Pick<ReturnType<typeof createRecoveryMachine>, "state" | "synced">;
  notifyRecovery(): void;
  onBaselineResolved?: (outcome: BaselineOutcome) => void;
  /**
   * Async loads check the epoch before touching session state, so a load that
   * settles after a reconnect (or after `destroy`) is dropped instead of applied
   * to a session it no longer belongs to.
   */
  getJoinEpoch(): number;
  /** `destroy()` does not bump the join epoch, so it is checked separately. */
  isDestroyed(): boolean;
  applyRemoteElements(elements: readonly SyncedElement[]): void;
  sendFullScene(): void;
  sendSceneDelta(): PublishOutcome;
  markFullSceneSyncedNow(): void;
  armSceneRepair(): void;
  publishLocalAssets(): void;
  snapshotBaseline: SnapshotBaselineSink;
  failRecovery(reason: UnrecoverableReason): void;
}): JoinBaselineGate => {
  const { context, snapshotStore, offlineQueue, recovery, snapshotBaseline } =
    options;

  /** Present only while the join barrier is holding inbound scene traffic. */
  let barrier: JoinBarrier | undefined;
  let cancelBaselineTimeout: (() => void) | undefined;
  /**
   * False until the first baseline resolves. A first join publishes the whole
   * canvas; only a *re*join has a room state to diff against.
   */
  let hasSynced = false;

  const clearBaselineTimeout = (): void => {
    cancelBaselineTimeout?.();
    cancelBaselineTimeout = undefined;
  };

  /**
   * Publishes what this client owes the room, once the baseline is in.
   *
   * A first join publishes the whole canvas: there is no prior room state to
   * measure against, and the snapshot is also what draws the peers' snapshot
   * replies. A rejoin has a choice, and the offline queue makes it:
   *
   * - Within its bounds, the pending delta is enough. The baseline was merged
   *   first, so what the tracker still holds is exactly the state the room does
   *   not have — usually a handful of elements rather than the whole scene.
   * - Over any bound, or with no baseline at all (the deadline expired), the
   *   whole scene goes out instead. One bounded full sync converges from any
   *   starting state, which is what makes it safe to stop being precise.
   */
  const publishAfterBaseline = (params: {
    rejoin: boolean;
    knowledge: BaselineKnowledge;
  }): void => {
    // The room holds state this client cannot read, so this canvas is not the
    // room's scene and publishing it would claim otherwise.
    if (params.knowledge === "unreadable") return;
    // A terminal failure resolved during this join for any other reason.
    if (recovery.state().phase === "failed") return;
    if (!context.connected || !context.canEditScene()) return;
    options.publishLocalAssets();
    const verdict = offlineQueue.drain(context.now());
    if (
      !params.rejoin ||
      params.knowledge === "unknown" ||
      verdict.mode === "full-sync"
    ) {
      options.sendFullScene();
      return;
    }
    // Both `delta` and `none` take this path: "nothing changed while offline"
    // still leaves the possibility that the last frame before the socket broke
    // never landed, and the pending set covers exactly that.
    //
    // The backstop is only rearmed when the delta actually went out. A refused
    // send leaves it where it was, so the retried flush publishes a full snapshot
    // instead of quietly waiting out the interval with unsent state.
    const published = options.sendSceneDelta();
    if (published === "failed") return;
    // The reconnect exchange reconciled this client with the room, so the periodic
    // backstop restarts from here rather than firing on the very next edit.
    options.markFullSceneSyncedNow();
    if (published === "sent") options.armSceneRepair();
  };

  /**
   * Opens the barrier: replays what it held, in arrival order, then publishes
   * what the room is missing so the rest of the room converges with us.
   *
   * Replay applies elements only — it deliberately does not run the per-message
   * snapshot-reply probe, because the single publish at the end is that probe,
   * and running it per replayed message would answer one join with a burst.
   */
  const releaseBarrier = (
    outcome: BaselineOutcome,
    knowledge: BaselineKnowledge,
  ): void => {
    const releasing = barrier;
    if (!releasing) return;
    clearBaselineTimeout();
    const held = releasing.release();
    barrier = undefined;
    for (const message of held) {
      options.applyRemoteElements(message.payload.elements);
    }
    const rejoin = hasSynced;
    hasSynced = true;
    if (recovery.state().phase === "syncing") {
      // Only a resolved baseline counts as progress, so this is also what clears
      // the retry budget: a relay that accepts joins and drops them keeps backing
      // off instead of hammering at the base delay.
      recovery.synced();
      options.notifyRecovery();
    }
    options.onBaselineResolved?.(outcome);
    // Also the repair for a buffer that overflowed: what we publish draws the
    // peers' snapshot replies, which carry whatever the drop lost.
    publishAfterBaseline({ rejoin, knowledge });
    // A viewer cannot publish, so the line above is not a repair for it. Re-read
    // the durable baseline instead, which recovers everything up to the last
    // stored snapshot without needing a frame the relay would refuse. Edits newer
    // than that snapshot still arrive with a peer's periodic full sync.
    if (releasing.needsSceneSync() && !context.canEditScene()) {
      void loadDurableBaseline(options.getJoinEpoch());
    }
  };

  /**
   * At join time the durable load races the elected peer's snapshot
   * deliberately, and whichever wins is accepted. An earlier design preferred
   * the peer and made the stored baseline wait, which read as "always use the
   * freshest state" but deadlocked the case that matters most: two clients
   * joining an empty room at the same moment each saw the other as its responder
   * and both stalled until the deadline. Racing is also simply better — the
   * loser's snapshot still arrives moments later as ordinary traffic and
   * reconciles, so the only difference is how fast the canvas paints.
   *
   * The same function serves the two later callers — a write that lost a revision
   * conflict, and a viewer whose join buffer overflowed — because both need
   * exactly this: the stored elements merged in, and the revision re-learned.
   *
   * Elements are applied whether or not the barrier is still holding. A load that
   * resolved after the deadline is still the room's history, and recording its
   * revision while discarding its contents is precisely how the next cadence tick
   * would come to overwrite a baseline this client never read.
   */
  const loadDurableBaseline = async (epoch: number): Promise<void> => {
    const result = snapshotStore
      ? await snapshotStore.load()
      : ({ status: "empty" } as const);
    if (options.isDestroyed() || epoch !== options.getJoinEpoch()) return;

    if (result.status === "loaded") {
      options.applyRemoteElements(result.elements);
      snapshotBaseline.adoptLoaded(result.revision);
      if (barrier?.claimBaseline()) releaseBarrier("durable-snapshot", "known");
      return;
    }
    if (result.status === "empty") {
      snapshotBaseline.adoptEmpty();
      // An empty room is a baseline: "the room has nothing" is knowledge, and it
      // is what makes a first publish of the local canvas correct.
      if (barrier?.claimBaseline()) releaseBarrier("empty", "known");
      return;
    }
    // The baseline stays unknown, and the cadence's write refuses while it is:
    // replacing a snapshot we could not read would destroy room history on the
    // strength of a canvas we have no reason to believe is complete.
    snapshotBaseline.markUnknown();
    const unreadable = result.reason === "wrong-key";
    if (barrier?.claimBaseline()) {
      releaseBarrier(
        unreadable ? "unreadable-snapshot" : "snapshot-unavailable",
        unreadable ? "unreadable" : "unknown",
      );
    }
    // A stored snapshot this client cannot open means the link's key cannot open
    // the room at all — realtime frames are sealed under a key derived from the
    // same material — so the session is terminal rather than merely stale. Failed
    // after the barrier reports the outcome, so the user still learns *why*.
    //
    // This is the *fast* detector, not the only one: a room with nothing stored
    // yet answers `empty` here and never reaches this branch, which is why the
    // transport's `onRoomUnreadable` verdict exists alongside it.
    if (unreadable) options.failRecovery("unreadable-room");
  };

  return {
    openBarrier(epoch) {
      barrier = createJoinBarrier(options.joinBarrierOptions);
      // Backstop for a store that never answers at all: the barrier must not hold
      // inbound traffic — or the canvas — indefinitely.
      cancelBaselineTimeout = context.scheduleTimeout(() => {
        cancelBaselineTimeout = undefined;
        if (epoch !== options.getJoinEpoch() || !barrier?.claimBaseline()) {
          return;
        }
        // No room state was obtained, so there is nothing to diff against and the
        // whole canvas goes out.
        releaseBarrier("snapshot-unavailable", "unknown");
      }, options.joinBaselineTimeoutMs);
      void loadDurableBaseline(epoch);
    },
    hasBarrier: () => barrier !== undefined,
    interceptSceneMessage(message, byteLength) {
      if (!barrier) return false;
      // The first snapshot to arrive is the baseline, whoever sent it. Later
      // snapshots (two responders briefly disagreeing about who answers) are
      // ordinary traffic, which is what makes duplicate replies harmless.
      if (message.type === "scene-init" && barrier.claimBaseline()) {
        options.applyRemoteElements(message.payload.elements);
        releaseBarrier("peer", "known");
        return true;
      }
      barrier.hold(message, byteLength);
      return true;
    },
    loadDurableBaseline,
    dispose() {
      clearBaselineTimeout();
      barrier?.dispose();
      barrier = undefined;
    },
  };
};
