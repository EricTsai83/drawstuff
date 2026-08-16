import type { SyncedElement } from "@drawstuff/collaboration/protocol";
import type { RoomPeer } from "@drawstuff/collaboration/transport";
import {
  collaborationSnapshotDigest,
  electSnapshotWriter,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";
import {
  getSyncableElements,
  reconcileRemoteElements,
} from "@drawstuff/excalidraw-adapter/reconcile";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import type { SnapshotBaselineSink } from "@/lib/collab/session/join-baseline";
import type { SessionContext } from "@/lib/collab/session/session-context";
import type { SyncBlockReporter } from "@/lib/collab/session/sync-block-reporter";
import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";

export type SnapshotCadence = SnapshotBaselineSink & {
  /** Publishes the durable snapshot; `force` marks the leave flush. */
  writeSnapshot(params?: { force?: boolean }): Promise<void>;
  start(epoch: number): void;
  stop(): void;
  /** New socket: the revision and digest belong to the previous session. */
  resetForConnection(): void;
};

/**
 * The durable-snapshot side of the session: the elected writer's cadence, the
 * conditional-revision bookkeeping, and the forced leave flush.
 *
 * It also owns what the join's baseline load learns (`SnapshotBaselineSink`),
 * because the revision and the "may this client replace the baseline" verdict
 * are one piece of state: only a client that knows the baseline may replace it.
 * Without that, a session that could not read the stored snapshot — a link
 * carrying the wrong key, or a failed fetch in an empty room — would see an
 * empty canvas, learn the real revision from its first conflict, and then
 * overwrite the room's history with that empty canvas. Refusing to write is the
 * safe direction: the room keeps a baseline this client cannot read, which is
 * exactly the truth of the situation.
 */
export const createSnapshotCadence = (options: {
  context: SessionContext;
  snapshotStore: CollaborationSnapshotStore | undefined;
  snapshotIntervalMs: number;
  getJoinEpoch(): number;
  /**
   * Both teardown flags, separately: a forced leave flush survives `destroy()`
   * (see `writeSnapshot`) but never a terminal recovery failure — a terminated
   * session may no longer vouch for the canvas.
   */
  isDestroyed(): boolean;
  isTerminated(): boolean;
  /** No write may happen while the join barrier still holds the baseline. */
  hasBarrier(): boolean;
  getRoomPeers(): readonly RoomPeer[];
  /** The cadence retries a failed baseline read at its own bounded pace. */
  loadDurableBaseline(epoch: number): Promise<void>;
  reporter: Pick<
    SyncBlockReporter,
    "noteSnapshotRefusedAsOversize" | "noteSnapshotWritten"
  >;
}): SnapshotCadence => {
  const { context, snapshotStore, snapshotIntervalMs, reporter } = options;
  const { sceneApi } = context;

  let cancelSnapshotCadence: (() => void) | undefined;
  /** Last revision this session knows the durable snapshot to be at. */
  let snapshotRevision = SNAPSHOT_NO_REVISION;
  /** Whether this session established what the room's baseline currently is. */
  let snapshotBaselineKnown = false;
  /** Digest of the element set last written, so an idle room writes nothing. */
  let lastSnapshotDigest: string | undefined;
  let snapshotWriteInFlight = false;
  /** The write currently settling, so a leave flush can queue behind it. */
  let inFlightWrite: Promise<void> | undefined;
  /**
   * Whether the most recent write lost a revision conflict. A leave flush that
   * queued behind that write consults this — not `snapshotBaselineKnown`, which
   * the conflict path may have already repaired by re-reading the winner — to
   * decide that its own save must be made to conflict and merge.
   */
  let lastSnapshotWriteConflicted = false;
  /**
   * Earliest instant the room's shared snapshot budget will accept another
   * write, as stated by the backend's last refusal.
   *
   * Held here rather than in the store because the cadence is here: the store
   * reports the deadline, the cadence is what decides not to call again.
   *
   * It binds the **cadence only**. A forced leave flush ignores it, because the
   * two sides of that trade are not comparable. A refused sliding-window request
   * consumes nothing — `@upstash/ratelimit` returns before it increments, so an
   * attempt that loses takes no token from the members who stayed and moves no
   * deadline — while skipping the flush can lose the room's newest state for
   * good: a leave may be the room emptying out, and teardown stops the cadence,
   * so there is no later tick to pick the edit up.
   */
  let snapshotWriteNotBefore = 0;

  const isElectedSnapshotWriter = (): boolean =>
    context.connected !== undefined &&
    electSnapshotWriter(options.getRoomPeers())?.peerId ===
      context.connected.peerId;

  /**
   * Publishes the durable snapshot.
   *
   * `force` marks the leave flush, and it is a different job from a cadence
   * write, because a leave may be the room emptying out — the one moment the
   * stored baseline is the only copy of the scene left anywhere. So a forced
   * write:
   *
   * - Survives `destroy()`. The digest is asynchronous, so a plain teardown
   *   guard would abort every single flush the moment the session was torn down
   *   in the same tick, which is exactly what `room-session.ts` does.
   * - Waits for an in-flight cadence write instead of skipping. That write
   *   carries the scene from *before* the user's last edit, and after teardown no
   *   further tick will ever pick that edit up.
   * - Bypasses the writer election. A crashed writer's departure notice may not
   *   have arrived yet, so the last live member can still believe the dead peer
   *   is the writer and skip the flush that matters most.
   * - Retries once on conflict, merging the winner rather than deferring to the
   *   next tick — there is no next tick.
   *
   * The role, baseline-known and conditional-revision checks apply to both kinds
   * of write: bypassing the *election* must not become bypassing authorization.
   */
  const writeSnapshot = async (params?: { force?: boolean }): Promise<void> => {
    const force = params?.force === true;
    // Every precondition is evaluated *before* the first await, and the scene is
    // captured with them. A leave flush is issued by a teardown that closes the
    // transport in the same tick — `connected` is cleared synchronously, and the
    // canvas may be handed to another scene moments later — so a guard or a
    // scene read on the far side of an await would see the torn-down world and
    // drop the room's last edits. The write itself goes over tRPC and needs no
    // live socket, so deciding now and writing later is sound.
    if (
      options.isTerminated() ||
      (options.isDestroyed() && !force) ||
      !snapshotStore ||
      !snapshotBaselineKnown ||
      (snapshotWriteInFlight && !force) ||
      !context.connected ||
      options.hasBarrier() ||
      !context.canEditScene() ||
      (!force && context.now() < snapshotWriteNotBefore) ||
      (!force && !isElectedSnapshotWriter())
    ) {
      return;
    }
    const store = snapshotStore;
    const epoch = options.getJoinEpoch();
    // Captured once. The forced retry below reuses these rather than re-reading
    // the canvas, which by then may no longer belong to the room.
    const elements = getSyncableElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      context.now(),
    ) as unknown as readonly SyncedElement[];
    // A leave flush queues behind the cadence write rather than dropping. The
    // cadence write carries the scene from *before* the edits this flush was
    // asked to persist, so waiting — with the decision to write already made —
    // is what keeps the newest state from losing to the older write's revision.
    const preWaitRevision = snapshotRevision;
    let awaitedWriteConflicted = false;
    if (force && inFlightWrite) {
      await inFlightWrite.catch(() => undefined);
      awaitedWriteConflicted = lastSnapshotWriteConflicted;
    }
    // The awaited write may have *lost* a revision conflict: it then adopted
    // the winner's revision, and the elements captured above predate whatever
    // the winner stored. Writing them under the adopted revision would sail
    // through the conditional write and erase the winner — whether or not the
    // conflict path managed to re-read the winner onto the canvas before this
    // ran, which is why the conflict itself is tracked rather than inferred
    // from `snapshotBaselineKnown`. Falling back to the revision captured with
    // the scene makes this save conflict too and routes it through the
    // merge-and-retry below.
    const expectedRevision = awaitedWriteConflicted
      ? preWaitRevision
      : snapshotRevision;
    const digest = await collaborationSnapshotDigest(elements);
    if ((options.isDestroyed() && !force) || epoch !== options.getJoinEpoch()) {
      return;
    }
    if (digest === lastSnapshotDigest && !force) {
      // Nothing to write — and that also means durability is *intact*, because
      // `lastSnapshotDigest` is only ever set by a write that landed. This has to
      // clear a latched block explicitly: an oversize edit that was subsequently
      // undone leaves the canvas byte-identical to the stored baseline, so the
      // write that would have cleared the block is exactly the write this return
      // skips, and the room would stay marked as un-backed-up for good.
      reporter.noteSnapshotWritten();
      return;
    }

    const run = async (): Promise<void> => {
      const result = await store.save({
        elements,
        expectedRevision,
        intent: force ? "leave" : "cadence",
      });
      // A write that settles after a reconnect must not seed the new session's
      // revision with the old one's answer.
      if (epoch !== options.getJoinEpoch()) return;
      if (result.status === "written") {
        snapshotRevision = result.revision;
        lastSnapshotDigest = digest;
        reporter.noteSnapshotWritten();
        return;
      }
      // The scene is past the locked snapshot contract, so every
      // remaining tick — and the leave flush that is the room's last chance to
      // persist anything — will be refused for the same reason. Unlike a failed
      // request this is not something waiting fixes, so it is surfaced instead of
      // being dropped along with the other non-conflict outcomes below.
      if (result.status === "oversize") {
        reporter.noteSnapshotRefusedAsOversize({
          byteLength: result.byteLength,
          maxByteLength: result.maxByteLength,
        });
        return;
      }
      // The room's shared write budget is spent. Retryable, and the next
      // cadence tick is the retry — but not before the window the server named,
      // because a tick inside it is a round trip that cannot succeed. It holds
      // back the cadence only: a forced flush still attempts, since a refused
      // request costs the room nothing and a skipped final flush costs it the
      // scene.
      if (result.status === "rate-limited") {
        snapshotWriteNotBefore = context.now() + result.retryAfterMs;
        return;
      }
      if (result.status !== "conflict") return;
      lastSnapshotWriteConflicted = true;

      // Not just the revision: the winner stored elements this client has not
      // read, so claiming to supersede them without merging would erase them.
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
      snapshotRevision = result.currentRevision ?? SNAPSHOT_NO_REVISION;

      if (!force) {
        // The next cadence tick is the retry, so all that is needed here is for
        // this client to learn what it lost to.
        if (!options.isDestroyed()) await options.loadDurableBaseline(epoch);
        return;
      }

      // Forced: there is no next tick. Merge the winner with the captured scene
      // and retry exactly once. The merge runs through the adapter's upstream
      // reconciliation rather than the canvas, because the canvas may already be
      // gone — and because the result has to contain *both* sides.
      const winner = await store.load();
      if (epoch !== options.getJoinEpoch() || winner.status !== "loaded") {
        return;
      }
      const merged = reconcileRemoteElements(
        elements as unknown as readonly OrderedExcalidrawElement[],
        winner.elements as unknown as readonly ExcalidrawElement[],
        sceneApi.getAppState(),
      ) as unknown as readonly SyncedElement[];
      const retried = await store.save({
        elements: merged,
        expectedRevision: winner.revision,
        intent: "leave",
      });
      if (epoch !== options.getJoinEpoch()) return;
      if (retried.status === "written") {
        snapshotRevision = retried.revision;
        snapshotBaselineKnown = true;
        reporter.noteSnapshotWritten();
        return;
      }
      if (retried.status === "rate-limited") {
        snapshotWriteNotBefore = context.now() + retried.retryAfterMs;
        return;
      }
      // Merging the winner can push a scene that fit on its own past the limit,
      // and this is the last write the room will get — so the refusal is reported
      // here too rather than only on the cadence path.
      if (retried.status === "oversize") {
        reporter.noteSnapshotRefusedAsOversize({
          byteLength: retried.byteLength,
          maxByteLength: retried.maxByteLength,
        });
      }
    };

    snapshotWriteInFlight = true;
    lastSnapshotWriteConflicted = false;
    const write = run();
    inFlightWrite = write;
    try {
      await write;
    } finally {
      snapshotWriteInFlight = false;
      if (inFlightWrite === write) inFlightWrite = undefined;
    }
  };

  const stop = (): void => {
    cancelSnapshotCadence?.();
    cancelSnapshotCadence = undefined;
  };

  return {
    writeSnapshot,
    stop,
    start(epoch) {
      stop();
      if (!snapshotStore) return;
      const tick = (): void => {
        cancelSnapshotCadence = undefined;
        if (options.isDestroyed() || epoch !== options.getJoinEpoch()) return;
        // "I do not know the baseline" disables writing, which is the safe
        // direction — but it must not be permanent. A snapshot fetch that failed
        // once at join time would otherwise leave the elected writer unable to
        // ever persist the room again, so the read is retried here at the same
        // bounded cadence. A genuinely unreadable snapshot simply keeps failing,
        // which correctly keeps writing disabled.
        if (snapshotBaselineKnown) {
          void writeSnapshot();
        } else {
          void options.loadDurableBaseline(epoch);
        }
        // Re-armed after each tick rather than as an interval, so a slow write
        // can never queue overlapping ticks.
        cancelSnapshotCadence = context.scheduleTimeout(
          tick,
          snapshotIntervalMs,
        );
      };
      cancelSnapshotCadence = context.scheduleTimeout(tick, snapshotIntervalMs);
    },
    resetForConnection() {
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
    },
    adoptLoaded(revision) {
      snapshotRevision = revision;
      snapshotBaselineKnown = true;
    },
    adoptEmpty() {
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = true;
    },
    markUnknown() {
      snapshotBaselineKnown = false;
    },
  };
};
