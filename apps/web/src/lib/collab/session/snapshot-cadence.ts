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

import {
  toExcalidrawElements,
  toSyncedElements,
} from "@/lib/collab/element-bridge";
import type { SnapshotBaselineSink } from "@/lib/collab/session/join-baseline";
import type { SessionContext } from "@/lib/collab/session/session-context";
import type { SyncBlockReporter } from "@/lib/collab/session/sync-block-reporter";
import { collectReferencedFileIds } from "@drawstuff/excalidraw-adapter/codec";
import type { CollaborationAssetStore } from "@/lib/collab/asset-store";
import {
  createRoomSaveState,
  type RoomSaveState,
} from "@/lib/collab/session/save-state";
import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";

export type SnapshotCadence = SnapshotBaselineSink & {
  /** Publishes the durable snapshot; `force` marks the leave flush. */
  writeSnapshot(params?: { force?: boolean }): Promise<void>;
  start(epoch: number): void;
  requestSave(fromPeer?: boolean): void;
  onSceneChange(): void;
  getSaveState(): RoomSaveState;
  receivePersisted(revision: number, checksum: string): void;
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
 * Without that, a session that could not read the stored snapshot — a damaged
 * snapshot, or a failed fetch in an empty room — would see an
 * empty canvas, learn the real revision from its first conflict, and then
 * overwrite the room's history with that empty canvas. Refusing to write is the
 * safe direction: the room keeps a baseline this client cannot read, which is
 * exactly the truth of the situation.
 */
export const createSnapshotCadence = (options: {
  context: SessionContext;
  snapshotStore: CollaborationSnapshotStore | undefined;
  snapshotIntervalMs: number;
  assetStore?: CollaborationAssetStore;
  onSaveStateChange?: (state: RoomSaveState) => void;
  sendSaveRequest?: () => void;
  onSnapshotWritten?: (receipt: {
    captureId: string;
    revision: number;
    checksum: string;
  }) => void;
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

  const saveState = createRoomSaveState({
    currentElements: () =>
      toSyncedElements(
        getSyncableElements(
          sceneApi.getSceneElementsIncludingDeleted(),
          context.now(),
        ),
      ),
    onChange: options.onSaveStateChange,
  });
  let lastObservedElements = sceneApi.getSceneElementsIncludingDeleted();
  let confirming = false;
  let cancelRequestDeadline: (() => void) | undefined;
  let lastVerificationAt = Number.NEGATIVE_INFINITY;
  let cancelVerification: (() => void) | undefined;
  const assetsAvailable = async (
    elements: readonly SyncedElement[],
  ): Promise<boolean> => {
    const ids = collectReferencedFileIds(elements);
    try {
      return (
        ids.length === 0 ||
        (await options.assetStore?.areAvailable?.(ids)) === true
      );
    } catch {
      return false;
    }
  };
  const confirm = async (
    revision: number,
    elements: readonly SyncedElement[],
    checksum?: string,
  ): Promise<void> => {
    const epoch = options.getJoinEpoch();
    const available = await assetsAvailable(elements);
    if (context.isStopped() || epoch !== options.getJoinEpoch()) return;
    if (!available) {
      saveState.failed();
      return;
    }
    saveState.confirm(revision, elements, checksum);
    if (saveState.state().status === "saved") {
      cancelRequestDeadline?.();
      cancelRequestDeadline = undefined;
    }
  };
  // Coalesced API verification: peer receipts are hints, never proof. A read
  // independently reads the stored bytes and checks their revision/checksum.
  const verifyPersisted = async (): Promise<void> => {
    if (
      !snapshotStore ||
      confirming ||
      context.isStopped() ||
      !context.connected ||
      !context.canSyncScene()
    )
      return;
    confirming = true;
    const epoch = options.getJoinEpoch();
    lastVerificationAt = context.now();
    try {
      const stored = await snapshotStore.load();
      if (context.isStopped() || epoch !== options.getJoinEpoch()) return;
      if (stored.status === "loaded")
        await confirm(stored.revision, stored.elements, stored.checksum);
      else if (stored.status === "empty") {
        snapshotRevision = stored.revision ?? SNAPSHOT_NO_REVISION;
        snapshotBaselineKnown = true;
        lastSnapshotDigest = undefined;
        saveState.invalidateConfirmation();
      } else if (stored.status === "unreadable") saveState.failed();
    } catch {
      saveState.failed();
    } finally {
      confirming = false;
    }
  };

  let cancelSnapshotCadence: (() => void) | undefined;
  /** Last revision this session knows the durable snapshot to be at. */
  let snapshotRevision = SNAPSHOT_NO_REVISION;
  /** Whether this session established what the room's baseline currently is. */
  let snapshotBaselineKnown = false;
  /** Digest of the element set last written, so an idle room writes nothing. */
  let lastSnapshotDigest: string | undefined;
  let snapshotWriteInFlight = false;
  let digestInFlight = false;
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
    // drop the room's last edits. The binary write needs no
    // live socket, so deciding now and writing later is sound.
    if (
      options.isTerminated() ||
      (options.isDestroyed() && !force) ||
      !snapshotStore ||
      !snapshotBaselineKnown ||
      ((snapshotWriteInFlight || digestInFlight) && !force) ||
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
    const syncableElements = getSyncableElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      context.now(),
    );
    const elements = toSyncedElements(syncableElements);
    const capturedFiles = sceneApi.getFiles();
    const capturedAppState = sceneApi.getAppState();
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
    digestInFlight = true;
    let digest: string;
    try {
      digest = await collaborationSnapshotDigest(elements);
    } finally {
      digestInFlight = false;
    }
    if ((options.isDestroyed() && !force) || epoch !== options.getJoinEpoch()) {
      return;
    }
    if (digest === lastSnapshotDigest && !force && !store.hasPendingWrite?.()) {
      // Nothing to write — and that also means durability is *intact*, because
      // `lastSnapshotDigest` is only ever set by a write that landed. This has to
      // clear a latched block explicitly: an oversize edit that was subsequently
      // undone leaves the canvas byte-identical to the stored baseline, so the
      // write that would have cleared the block is exactly the write this return
      // skips, and the room would stay marked as un-backed-up for good.
      reporter.noteSnapshotWritten();
      // A previously loaded snapshot may have lacked finalized attachments.
      // Retry the independent read even when the element digest is unchanged.
      if (saveState.state().status !== "saved") await verifyPersisted();
      return;
    }

    const run = async (): Promise<void> => {
      saveState.saving();
      // Upload only referenced local images, then independently check all
      // records. A snapshot cannot confirm a not-yet-finalized attachment.
      const ids = collectReferencedFileIds(elements);
      if (ids.length > 0 && context.canEditScene()) {
        const files = capturedFiles;
        await options.assetStore?.publish(
          ids.flatMap((id) => (files[id] ? [files[id]] : [])),
        );
      }
      if (!(await assetsAvailable(elements))) {
        saveState.failed();
        return;
      }
      if (
        epoch !== options.getJoinEpoch() ||
        options.isTerminated() ||
        (options.isDestroyed() && !force)
      )
        return;
      const captureId = crypto.randomUUID();
      // This mutation may replace the previously confirmed baseline even if
      // its reply is lost. Reverting the canvas cannot revive that old ACK.
      saveState.invalidateConfirmation();
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
        await confirm(result.revision, elements, result.checksum);
        if (!context.isStopped() && result.checksum)
          options.onSnapshotWritten?.({
            captureId,
            revision: result.revision,
            checksum: result.checksum,
          });
        reporter.noteSnapshotWritten();
        return;
      }
      // The scene is past the locked snapshot contract, so every
      // remaining tick — and the leave flush that is the room's last chance to
      // persist anything — will be refused for the same reason. Unlike a failed
      // request this is not something waiting fixes, so it is surfaced instead of
      // being dropped along with the other non-conflict outcomes below.
      saveState.failed();
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
      if (epoch !== options.getJoinEpoch() || winner.status === "unreadable") {
        return;
      }
      const merged =
        winner.status === "empty"
          ? elements
          : toSyncedElements(
              reconcileRemoteElements(
                syncableElements,
                toExcalidrawElements(winner.elements),
                capturedAppState,
              ),
            );
      const retried = await store.save({
        elements: merged,
        expectedRevision: winner.revision ?? SNAPSHOT_NO_REVISION,
        intent: "leave",
      });
      if (epoch !== options.getJoinEpoch()) return;
      if (retried.status === "written") {
        snapshotRevision = retried.revision;
        snapshotBaselineKnown = true;
        await confirm(retried.revision, merged, retried.checksum);
        if (!context.isStopped() && retried.checksum)
          options.onSnapshotWritten?.({
            captureId,
            revision: retried.revision,
            checksum: retried.checksum,
          });
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
    } catch {
      saveState.failed();
    } finally {
      snapshotWriteInFlight = false;
      if (inFlightWrite === write) inFlightWrite = undefined;
    }
  };

  const stop = (): void => {
    cancelSnapshotCadence?.();
    cancelSnapshotCadence = undefined;
    cancelRequestDeadline?.();
    cancelRequestDeadline = undefined;
    cancelVerification?.();
    cancelVerification = undefined;
  };

  return {
    writeSnapshot,
    stop,
    onSceneChange() {
      const elements = sceneApi.getSceneElementsIncludingDeleted();
      if (elements === lastObservedElements) return;
      lastObservedElements = elements;
      saveState.changed();
    },
    getSaveState: () => saveState.state(),
    receivePersisted(revision, _checksum) {
      if (revision <= (saveState.state().revision ?? 0) || cancelVerification)
        return;
      const delay = Math.max(0, 1_000 - (context.now() - lastVerificationAt));
      cancelVerification = context.scheduleTimeout(() => {
        cancelVerification = undefined;
        void verifyPersisted();
      }, delay);
    },
    requestSave(fromPeer = false) {
      if (fromPeer && !isElectedSnapshotWriter()) return;
      if (
        context.isStopped() ||
        !context.canEditScene() ||
        options.hasBarrier()
      )
        return;
      if (saveState.state().status === "saved") return;
      saveState.saving();
      cancelRequestDeadline ??= context.scheduleTimeout(() => {
        cancelRequestDeadline = undefined;
        if (saveState.state().status !== "saved") saveState.failed();
      }, snapshotIntervalMs);
      if (isElectedSnapshotWriter()) {
        if (snapshotBaselineKnown) void writeSnapshot();
        else
          void options
            .loadDurableBaseline(options.getJoinEpoch())
            .then(() => writeSnapshot());
      } else options.sendSaveRequest?.();
    },
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
          if (isElectedSnapshotWriter()) void writeSnapshot();
          else if (saveState.state().status !== "saved") void verifyPersisted();
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
      saveState.reset();
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
    },
    adoptLoaded(revision, elements, checksum) {
      if (elements) {
        const epoch = options.getJoinEpoch();
        void confirm(revision, elements, checksum);
        void collaborationSnapshotDigest(elements).then((digest) => {
          if (
            !context.isStopped() &&
            epoch === options.getJoinEpoch() &&
            snapshotRevision === revision
          )
            lastSnapshotDigest = digest;
        });
      }
      snapshotRevision = revision;
      snapshotBaselineKnown = true;
    },
    adoptEmpty(revision = SNAPSHOT_NO_REVISION) {
      snapshotRevision = revision;
      snapshotBaselineKnown = true;
      lastSnapshotDigest = undefined;
      saveState.invalidateConfirmation();
    },
    markUnknown() {
      snapshotBaselineKnown = false;
    },
  };
};
