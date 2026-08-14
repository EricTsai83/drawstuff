import type {
  SceneMessage,
  SyncedElement,
} from "@drawstuff/collaboration/protocol";
import type { createOfflineChangeQueue } from "@drawstuff/collaboration/offline-queue";
import type { UnrecoverableReason } from "@drawstuff/collaboration/recovery";
import type {
  CollaborationTransport,
  SendError,
} from "@drawstuff/collaboration/transport";
import type { createChangedElementTracker } from "@drawstuff/excalidraw-adapter/reconcile";

import type {
  BuildEnvelope,
  SessionContext,
} from "@/lib/collab/session/session-context";
import type { SyncBlockReporter } from "@/lib/collab/session/sync-block-reporter";

/**
 * What a publish attempt did. `nothing-to-send` is not a failure: it is the room
 * already having everything this client holds, which is the normal steady state.
 */
export type PublishOutcome = "sent" | "nothing-to-send" | "failed";

export type ScenePublisher = {
  sendFullScene(): void;
  /**
   * Sends the elements the tracker still holds as pending, as one delta.
   *
   * Used both by the ordinary flush and by a rejoin. On a rejoin the pending set
   * is precisely what the room's baseline did not already have: the tracker is
   * reset on connect, and applying the baseline marks everything the baseline won
   * as synced, so what is left is exactly the state this client owes the room.
   * That derivation is deliberate — it does not depend on the tracker's beliefs
   * from before the socket broke, which are exactly the beliefs a lost final
   * frame would have made wrong.
   */
  sendSceneDelta(): PublishOutcome;
  /** Schedules one coalesced flush; idempotent while one is pending. */
  scheduleFlush(): void;
  cancelPendingFlush(): void;
  /** The reconnect exchange reconciled us; restart the periodic backstop. */
  markFullSceneSyncedNow(): void;
  /** New socket: sequences restart and the full-sync backstop rewinds. */
  resetForConnection(): void;
};

/** Outbound scene traffic: the coalesced flush, deltas, and full snapshots. */
export const createScenePublisher = (options: {
  context: SessionContext;
  transport: Pick<CollaborationTransport, "sendSceneMessage">;
  tracker: ReturnType<typeof createChangedElementTracker>;
  offlineQueue: ReturnType<typeof createOfflineChangeQueue>;
  buildEnvelope: BuildEnvelope;
  /** Coalesces local scene flushes and returns a cancel function. */
  scheduleSceneFlush(flush: () => void): () => void;
  fullSceneSyncIntervalMs: number;
  /** Nothing may be published before the join baseline lands. */
  hasBarrier(): boolean;
  publishLocalAssets(): void;
  armSceneRepair(): void;
  reporter: Pick<
    SyncBlockReporter,
    "noteSceneSendRefusedAsOversize" | "noteSceneSendAccepted"
  >;
  failRecovery(reason: UnrecoverableReason): void;
}): ScenePublisher => {
  const {
    context,
    transport,
    tracker,
    offlineQueue,
    buildEnvelope,
    fullSceneSyncIntervalMs,
    reporter,
  } = options;
  const { sceneApi } = context;

  let sceneSequence = 0;
  let lastFullSceneSyncAt = Number.NEGATIVE_INFINITY;
  let cancelPendingFlush: (() => void) | undefined;

  /**
   * Applies the send policy to a failed scene send.
   *
   * `crypto-exhausted` is terminal and has to be treated as such: the derived key
   * is per room generation, not per session, so reconnecting does not buy a fresh
   * nonce budget and a session that keeps trying would drop every edit silently.
   * A full outbound queue self-heals — nothing was marked sent, so the next flush
   * re-extracts the same elements.
   *
   * `oversize-payload` is the case that neither self-heals nor ends the session,
   * so it is the one that has to be *reported*. The scene is past the locked
   * per-message contract, which the relay enforces too, so no amount of
   * retrying will get it through — but the session is otherwise healthy, and the
   * fix is a local edit away. Keeping the connection and announcing that outbound
   * sync has stopped is therefore the honest state; terminating would throw away
   * a session the user can still recover, and staying quiet is the silent-stop
   * this branch exists to remove.
   */
  const handleSceneSendError = (error: SendError): void => {
    if (error.code === "crypto-exhausted") {
      options.failRecovery("crypto-exhausted");
      return;
    }
    if (error.code === "oversize-payload") {
      reporter.noteSceneSendRefusedAsOversize({
        byteLength: error.byteLength,
        maxByteLength: error.maxByteLength,
      });
      return;
    }
    if (error.code === "queue-overflow") {
      scheduleFlush();
    }
  };

  const sendFullScene = (): void => {
    // Nothing may be published before the baseline lands: until then this canvas
    // is not yet the room's scene, and broadcasting it would push pre-join local
    // state into the room.
    const connected = context.connected;
    if (options.hasBarrier() || !connected || !context.canEditScene()) return;
    const currentNow = context.now();
    const batch = tracker.extractChangedElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      { now: currentNow, syncAll: true },
    );
    const message: SceneMessage = {
      ...buildEnvelope(connected, sceneSequence + 1),
      type: "scene-init",
      // Element bodies are engine-owned and pass through unprojected; the
      // codec re-validates the identity fields on send.
      payload: { elements: batch.elements as unknown as SyncedElement[] },
    };
    const result = transport.sendSceneMessage(message);
    if (result.ok) {
      sceneSequence += 1;
      batch.markSent();
      reporter.noteSceneSendAccepted();
      lastFullSceneSyncAt = currentNow;
      // Armed even though this published everything: this very snapshot can be
      // the message that gets dropped, and then nothing else would retry it. An
      // empty scene is exempt — there is no state a drop could lose.
      if (batch.elements.length > 0) options.armSceneRepair();
      return;
    }
    handleSceneSendError(result.error);
  };

  const sendSceneDelta = (): PublishOutcome => {
    const connected = context.connected;
    if (options.hasBarrier() || !connected || !context.canEditScene()) {
      return "failed";
    }
    const currentNow = context.now();
    const batch = tracker.extractChangedElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      { now: currentNow },
    );
    // Nothing pending means the room already has everything this client holds, so
    // there is no send to make and nothing a repair could re-send.
    if (batch.elements.length === 0) return "nothing-to-send";
    const message: SceneMessage = {
      ...buildEnvelope(connected, sceneSequence + 1),
      type: "scene-update",
      payload: { elements: batch.elements as unknown as SyncedElement[] },
    };
    const result = transport.sendSceneMessage(message);
    if (result.ok) {
      sceneSequence += 1;
      batch.markSent();
      reporter.noteSceneSendAccepted();
      return "sent";
    }
    // Nothing was marked sent, so the tracker still holds every pending
    // element — the scene itself is the bounded offline queue.
    handleSceneSendError(result.error);
    return "failed";
  };

  /**
   * Accounts for local edits made while the session is down.
   *
   * Extraction only — nothing is marked sent, because nothing was sent. The
   * queue keeps identity and size, so the element bodies stay in the scene and
   * the reconnect re-reads them; an element drawn and then deleted while offline
   * is therefore replayed as the tombstone it became.
   */
  const recordOfflineChanges = (): void => {
    const currentNow = context.now();
    const batch = tracker.extractChangedElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      { now: currentNow },
    );
    offlineQueue.record(
      batch.elements as unknown as readonly SyncedElement[],
      currentNow,
    );
  };

  const flushLocalScene = (): void => {
    cancelPendingFlush = undefined;
    if (!context.canSyncScene()) return;
    // Disconnected: account for the change, bounded, so the reconnect can decide
    // between replaying a delta and falling back to one full sync.
    if (!context.connected) {
      recordOfflineChanges();
      return;
    }
    // Local edits made during the join window are not lost either: the tracker
    // still holds them, and the rejoin publish that follows the baseline carries
    // them.
    if (options.hasBarrier() || !context.canEditScene()) return;
    options.publishLocalAssets();
    const currentNow = context.now();
    // Throttled full resync (upstream SYNC_FULL_SCENE_INTERVAL_MS): a
    // snapshot supersedes the delta and heals any receiver-side gaps.
    if (currentNow - lastFullSceneSyncAt >= fullSceneSyncIntervalMs) {
      sendFullScene();
      return;
    }
    // Armed only when something actually went on the wire: a repair exists to
    // re-send state that may have been dropped, and a send that carried nothing
    // has nothing to lose.
    if (sendSceneDelta() === "sent") options.armSceneRepair();
  };

  const scheduleFlush = (): void => {
    if (context.isStopped() || cancelPendingFlush) return;
    cancelPendingFlush = options.scheduleSceneFlush(flushLocalScene);
  };

  return {
    sendFullScene,
    sendSceneDelta,
    scheduleFlush,
    cancelPendingFlush() {
      cancelPendingFlush?.();
      cancelPendingFlush = undefined;
    },
    markFullSceneSyncedNow() {
      lastFullSceneSyncAt = context.now();
    },
    resetForConnection() {
      sceneSequence = 0;
      lastFullSceneSyncAt = Number.NEGATIVE_INFINITY;
    },
  };
};
