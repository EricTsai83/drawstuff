import type {
  CollaborationMessage,
  InboundMessageGate,
  PresenceMessage,
  SceneMessage,
  SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { EXCALIDRAW_CAPTURE_UPDATE_ACTION } from "@drawstuff/excalidraw-adapter/client";
import {
  getSyncableElements,
  reconcileRemoteElements,
  type createChangedElementTracker,
} from "@drawstuff/excalidraw-adapter/reconcile";

import { toExcalidrawElements } from "@/lib/collab/element-bridge";
import type { SessionContext } from "@/lib/collab/session/session-context";

export type RemoteApplier = {
  /**
   * Merges remote elements into the canvas through the adapter's upstream
   * reconciliation boundary. The single write path for every source of remote
   * state: peer deltas, peer snapshots and the durable snapshot.
   */
  applyRemoteElements(elements: readonly SyncedElement[]): void;
  /** The transport subscriber's message entry point. */
  handleRemoteMessage(
    message: CollaborationMessage,
    meta: { byteLength: number },
  ): void;
};

/** Inbound side of the session: gate → barrier → canvas, plus the replies. */
export const createRemoteApplier = (options: {
  context: SessionContext;
  tracker: ReturnType<typeof createChangedElementTracker>;
  wrapRemoteApply: (apply: () => void) => void;
  getGate: () => InboundMessageGate | undefined;
  /** Presence settles asynchronously; membership is the synchronous truth. */
  isKnownPeer: (peerId: string) => boolean;
  receivePresence: (message: PresenceMessage) => void;
  /** Join-baseline barrier; true when it consumed the message. */
  interceptSceneMessage: (message: SceneMessage, byteLength: number) => boolean;
  requestMissingAssets: (elements: readonly SyncedElement[]) => void;
  noteRoomActivity: () => void;
  sendFullScene: () => void;
}): RemoteApplier => {
  const { context, tracker, wrapRemoteApply } = options;
  const { sceneApi } = context;

  const applyRemoteElements = (elements: readonly SyncedElement[]): void => {
    // The canvas may have been replaced by another scene since this state was
    // produced; applying room state to it would corrupt that scene.
    if (!context.canSyncScene()) return;
    wrapRemoteApply(() => {
      const localElements = sceneApi.getSceneElementsIncludingDeleted();
      const reconciled = reconcileRemoteElements(
        localElements,
        toExcalidrawElements(elements),
        sceneApi.getAppState(),
      );
      sceneApi.updateScene({
        elements: reconciled,
        captureUpdate: EXCALIDRAW_CAPTURE_UPDATE_ACTION.NEVER,
      });
      tracker.markAdoptedRemoteElements(reconciled, elements);
    });
    options.requestMissingAssets(elements);
  };

  /**
   * A received snapshot is also a convergence probe: when our reconciled
   * scene still holds syncable state the snapshot lacks (an element the
   * sender never saw, or a version our side won), reply with our own
   * snapshot. Equal states produce no reply, so the exchange terminates.
   */
  const sceneInitNeedsReply = (
    remoteElements: readonly SyncedElement[],
  ): boolean => {
    const remoteById = new Map(
      remoteElements.map((element) => [element.id, element]),
    );
    return getSyncableElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      context.now(),
    ).some((element) => {
      const remote = remoteById.get(element.id);
      return (
        remote === undefined ||
        element.version > remote.version ||
        (element.version === remote.version &&
          element.versionNonce !== remote.versionNonce)
      );
    });
  };

  const deliverSceneMessage = (
    message: SceneMessage,
    sceneSyncRequired: boolean,
  ): void => {
    // Inbound scene traffic means the reactive repair paths are working, so the
    // timer-driven budget is restored.
    options.noteRoomActivity();
    applyRemoteElements(message.payload.elements);
    if (message.type === "scene-init") {
      if (sceneInitNeedsReply(message.payload.elements)) {
        options.sendFullScene();
      }
      return;
    }
    // A sequence gap means we missed deltas from this sender. Broadcasting
    // our snapshot triggers the sender's scene-init reply above, which
    // carries the state we missed; the throttled full sync is the backstop.
    if (sceneSyncRequired) options.sendFullScene();
  };

  return {
    applyRemoteElements,
    handleRemoteMessage(message, meta) {
      const gate = options.getGate();
      if (!context.connected || !gate) return;
      const verdict = gate.accept(message);
      if (verdict.action === "reject") return;

      if (message.type === "presence") {
        // Presence never enters the barrier: it carries no scene state, so holding
        // it would only make other people's cursors lag behind the join.
        //
        // Only from current members: presence settles asynchronously (decryption
        // queue) while membership updates synchronously, so a frame queued before
        // a peer left can land after the prune. Re-inserting it would resurrect
        // the departed cursor — and since a reconnect is a new peerId, nothing
        // would ever overwrite the stale key until the next membership change.
        if (!options.isKnownPeer(message.senderPeerId)) return;
        options.receivePresence(message);
        return;
      }

      if (options.interceptSceneMessage(message, meta.byteLength)) return;

      deliverSceneMessage(message, verdict.sceneSyncRequired);
    },
  };
};
