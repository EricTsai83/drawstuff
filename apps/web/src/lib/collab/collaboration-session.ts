import {
  COLLABORATION_PROTOCOL_VERSION,
  createInboundMessageGate,
  type ClientId,
  type CollaborationMessage,
  type InboundMessageGate,
  type PresenceMessage,
  type RoomId,
  type SceneMessage,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { roomRoleCanEditScene } from "@drawstuff/collaboration/room-auth";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
  TransportSubscriber,
} from "@drawstuff/collaboration/transport";
import {
  EXCALIDRAW_CAPTURE_UPDATE_ACTION,
  EXCALIDRAW_USER_IDLE_STATE,
} from "@drawstuff/excalidraw-adapter/client";
import {
  createChangedElementTracker,
  getSyncableElements,
  reconcileRemoteElements,
  type ReconciliationLocalState,
} from "@drawstuff/excalidraw-adapter/reconcile";
import type {
  AppState,
  Collaborator,
  ExcalidrawElement,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
  SceneData,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

/**
 * Mirrors the upstream collab app's cadence: deltas coalesce per animation
 * frame, presence is throttled to ~30fps (`CURSOR_SYNC_TIMEOUT`), and a full
 * snapshot is rebroadcast at most every 20s while edits happen
 * (`SYNC_FULL_SCENE_INTERVAL_MS`) so dropped deltas always heal.
 */
export const FULL_SCENE_SYNC_INTERVAL_MS = 20_000;
export const PRESENCE_THROTTLE_MS = 33;

/** Longest scene-flush coalescing window when animation frames are throttled
 *  (hidden tab): a plain timer backstop keeps outbound deltas moving. */
const SCENE_FLUSH_BACKSTOP_MS = 32;

const MAX_PRESENCE_SELECTED_ELEMENT_IDS = 256;
const MAX_PRESENCE_ELEMENT_ID_LENGTH = 64;
const MAX_MESSAGE_ID_LENGTH = 64;

type PresencePayload = PresenceMessage["payload"];
export type CollaborationIdleState = PresencePayload["idleState"];

const USER_IDLE_STATE_BY_PRESENCE = {
  active: EXCALIDRAW_USER_IDLE_STATE.ACTIVE,
  idle: EXCALIDRAW_USER_IDLE_STATE.IDLE,
  away: EXCALIDRAW_USER_IDLE_STATE.AWAY,
} as const;

/**
 * The slice of `ExcalidrawImperativeAPI` the session reads and writes, kept
 * minimal so tests can drive the session with a plain in-memory scene host.
 */
export type CollaborationSceneApi = {
  getSceneElementsIncludingDeleted(): readonly OrderedExcalidrawElement[];
  getAppState(): ReconciliationLocalState;
  updateScene(
    sceneData: Pick<SceneData, "elements" | "collaborators" | "captureUpdate">,
  ): void;
};

export type CollaborationSessionOptions = {
  transport: CollaborationTransport;
  roomId: RoomId;
  clientId: ClientId;
  /**
   * Short-lived join token from `collaborationRoom.join`. The session never
   * decides its own role: the granted role comes back in the connected state.
   */
  joinToken: string;
  username: string;
  sceneApi: CollaborationSceneApi;
  /**
   * Every canvas write triggered by remote input (scene deltas, snapshots and
   * presence) runs through this wrapper, so the host can suppress its own
   * `onChange` side effects (dirty tracking) for the write. Defaults to a
   * plain call.
   */
  wrapRemoteApply?: (apply: () => void) => void;
  /**
   * Coalesces local scene flushes and returns a cancel function. Defaults to
   * one animation frame with a short timer backstop; tests inject a manual
   * scheduler for determinism.
   */
  scheduleSceneFlush?: (flush: () => void) => () => void;
  /**
   * Checked synchronously before every scene read or write. When it returns
   * false the canvas no longer holds this room's scene, so the session neither
   * broadcasts what is on it nor applies room traffic to it. Presence is
   * unaffected: it carries no scene state.
   */
  canSyncScene?: () => boolean;
  now?: () => number;
  fullSceneSyncIntervalMs?: number;
  presenceThrottleMs?: number;
};

export type CollaborationSession = {
  connect(): void;
  disconnect(): void;
  /** Unsubscribes from the transport and cancels every scheduled flush. The
   *  transport itself stays owned by the caller. */
  destroy(): void;
  /** Wire to the editor `onChange`: schedules one coalesced delta flush.
   *  Pointer-only changes extract nothing and produce no scene message. */
  handleLocalSceneChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ): void;
  /** Wire to the editor `onPointerUpdate`: sends bounded-throttle presence. */
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
  setIdleState(idleState: CollaborationIdleState): void;
  getConnectionState(): ConnectionState;
};

const defaultScheduleSceneFlush = (flush: () => void): (() => void) => {
  // Animation frame for the common case; the timer backstop keeps deltas
  // flowing when the tab is hidden and frames stop firing. Whichever fires
  // first wins and cancels the other.
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cancel();
    flush();
  };
  const frameId =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(run)
      : undefined;
  const timerId = setTimeout(run, SCENE_FLUSH_BACKSTOP_MS);
  const cancel = (): void => {
    if (frameId !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
    }
    clearTimeout(timerId);
  };
  return () => {
    done = true;
    cancel();
  };
};

export function createCollaborationSession(
  options: CollaborationSessionOptions,
): CollaborationSession {
  const {
    transport,
    roomId,
    clientId,
    joinToken,
    username,
    sceneApi,
    wrapRemoteApply = (apply) => {
      apply();
    },
    scheduleSceneFlush = defaultScheduleSceneFlush,
    now = Date.now,
    fullSceneSyncIntervalMs = FULL_SCENE_SYNC_INTERVAL_MS,
    presenceThrottleMs = PRESENCE_THROTTLE_MS,
    canSyncScene = () => true,
  } = options;

  type ConnectedState = Extract<ConnectionState, { status: "connected" }>;

  let destroyed = false;
  let connected: ConnectedState | undefined;
  let gate: InboundMessageGate | undefined;
  const tracker = createChangedElementTracker();

  let sceneSequence = 0;
  let presenceSequence = 0;
  let messageCounter = 0;
  let lastFullSceneSyncAt = Number.NEGATIVE_INFINITY;
  let lastPresenceSentAt = Number.NEGATIVE_INFINITY;
  let cancelPendingFlush: (() => void) | undefined;
  let knownPeerIds = new Set<string>();

  let lastPointer: PresencePayload["pointer"] | undefined;
  let lastButton: PresencePayload["button"] = "up";
  let lastSelectedElementIds: readonly string[] = [];
  let idleState: CollaborationIdleState = "active";

  /** Latest presence per collaborator client; replaced wholesale on apply so
   *  the engine always receives a fresh Map. Bounded by room membership. */
  const collaborators = new Map<ClientId, Collaborator>();

  const nextMessageId = (): string => {
    messageCounter += 1;
    const peerId = connected?.peerId ?? "detached";
    return `m${messageCounter}-${peerId}`.slice(0, MAX_MESSAGE_ID_LENGTH);
  };

  type MessageEnvelope = Pick<
    PresenceMessage,
    | "protocolVersion"
    | "messageId"
    | "roomId"
    | "roomGeneration"
    | "senderClientId"
    | "senderPeerId"
    | "sequence"
  >;

  const buildEnvelope = (
    session: ConnectedState,
    sequence: number,
  ): MessageEnvelope => ({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    messageId: nextMessageId(),
    roomId: session.roomId,
    roomGeneration: session.roomGeneration,
    senderClientId: session.clientId,
    senderPeerId: session.peerId,
    sequence,
  });

  const applyCollaborators = (): void => {
    const next = new Map<SocketId, Collaborator>();
    for (const [collaboratorClientId, collaborator] of collaborators) {
      next.set(collaboratorClientId as unknown as SocketId, collaborator);
    }
    wrapRemoteApply(() => {
      sceneApi.updateScene({ collaborators: next });
    });
  };

  /**
   * A viewer never produces scene traffic. The relay refuses it anyway (and
   * closes the socket for trying), so this keeps a read-only session from
   * disconnecting itself; presence remains allowed for both roles.
   */
  const canEditScene = (): boolean =>
    connected !== undefined &&
    roomRoleCanEditScene(connected.role) &&
    canSyncScene();

  const sendFullScene = (): void => {
    if (!connected || !canEditScene()) return;
    const currentNow = now();
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
    if (transport.sendSceneMessage(message).ok) {
      sceneSequence += 1;
      batch.markSent();
      lastFullSceneSyncAt = currentNow;
    }
  };

  const flushLocalScene = (): void => {
    cancelPendingFlush = undefined;
    if (!connected || !canEditScene()) return;
    const currentNow = now();
    // Throttled full resync (upstream SYNC_FULL_SCENE_INTERVAL_MS): a
    // snapshot supersedes the delta and heals any receiver-side gaps.
    if (currentNow - lastFullSceneSyncAt >= fullSceneSyncIntervalMs) {
      sendFullScene();
      return;
    }
    const batch = tracker.extractChangedElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      { now: currentNow },
    );
    if (batch.elements.length === 0) return;
    const message: SceneMessage = {
      ...buildEnvelope(connected, sceneSequence + 1),
      type: "scene-update",
      payload: { elements: batch.elements as unknown as SyncedElement[] },
    };
    const result = transport.sendSceneMessage(message);
    if (result.ok) {
      sceneSequence += 1;
      batch.markSent();
      return;
    }
    // Nothing was marked sent, so the tracker still holds every pending
    // element — the scene itself is the bounded offline queue. A full
    // outbound queue self-heals by re-extracting on the next flush.
    if (result.error.code === "queue-overflow") {
      scheduleFlush();
    }
  };

  const scheduleFlush = (): void => {
    if (destroyed || cancelPendingFlush) return;
    cancelPendingFlush = scheduleSceneFlush(flushLocalScene);
  };

  const sendPresence = (): void => {
    if (!connected || !lastPointer) return;
    const message: PresenceMessage = {
      ...buildEnvelope(connected, presenceSequence + 1),
      type: "presence",
      payload: {
        pointer: lastPointer,
        button: lastButton,
        username,
        selectedElementIds: [...lastSelectedElementIds],
        idleState,
      },
    };
    if (transport.sendPresenceMessage(message).ok) {
      presenceSequence += 1;
      lastPresenceSentAt = now();
    }
  };

  const toCollaborator = (message: PresenceMessage): Collaborator => {
    const selectedElementIds: Record<string, true> = {};
    for (const id of message.payload.selectedElementIds) {
      selectedElementIds[id] = true;
    }
    return {
      pointer: message.payload.pointer,
      button: message.payload.button,
      username: message.payload.username,
      selectedElementIds,
      userState: USER_IDLE_STATE_BY_PRESENCE[message.payload.idleState],
      id: message.senderClientId,
      socketId: message.senderClientId as unknown as SocketId,
    };
  };

  const applyRemoteSceneMessage = (message: SceneMessage): void => {
    // The canvas may have been replaced by another scene since this message
    // was sent; applying room state to it would corrupt that scene.
    if (!canSyncScene()) return;
    wrapRemoteApply(() => {
      const localElements = sceneApi.getSceneElementsIncludingDeleted();
      const remoteElements = message.payload
        .elements as unknown as readonly ExcalidrawElement[];
      const reconciled = reconcileRemoteElements(
        localElements,
        remoteElements,
        sceneApi.getAppState(),
      );
      sceneApi.updateScene({
        elements: reconciled,
        captureUpdate: EXCALIDRAW_CAPTURE_UPDATE_ACTION.NEVER,
      });
      tracker.markAdoptedRemoteElements(reconciled, message.payload.elements);
    });
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
      now(),
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

  const handleRemoteMessage = (message: CollaborationMessage): void => {
    if (!connected || !gate) return;
    const verdict = gate.accept(message);
    if (verdict.action === "reject") return;

    if (message.type === "presence") {
      collaborators.set(message.senderClientId, toCollaborator(message));
      applyCollaborators();
      return;
    }

    applyRemoteSceneMessage(message);
    if (message.type === "scene-init") {
      if (sceneInitNeedsReply(message.payload.elements)) sendFullScene();
      return;
    }
    // A sequence gap means we missed deltas from this sender. Broadcasting
    // our snapshot triggers the sender's scene-init reply above, which
    // carries the state we missed; the throttled full sync is the backstop.
    if (verdict.sceneSyncRequired) sendFullScene();
  };

  const handleConnectionStateChange = (state: ConnectionState): void => {
    if (state.status === "connected") {
      connected = state;
      gate = createInboundMessageGate({
        roomId: state.roomId,
        roomGeneration: state.roomGeneration,
      });
      tracker.reset();
      sceneSequence = 0;
      presenceSequence = 0;
      lastFullSceneSyncAt = Number.NEGATIVE_INFINITY;
      lastPresenceSentAt = Number.NEGATIVE_INFINITY;
      knownPeerIds = new Set([state.peerId]);
      sendFullScene();
      return;
    }
    connected = undefined;
    gate = undefined;
    if (collaborators.size > 0) {
      collaborators.clear();
      applyCollaborators();
    }
  };

  const handleRoomPeersChange = (peers: readonly RoomPeer[]): void => {
    if (!connected) return;
    const selfPeerId = connected.peerId;
    const previousPeerIds = knownPeerIds;
    knownPeerIds = new Set(peers.map((peer) => peer.peerId));

    const activeClientIds = new Set(peers.map((peer) => peer.clientId));
    let membershipChanged = false;
    for (const collaboratorClientId of [...collaborators.keys()]) {
      if (!activeClientIds.has(collaboratorClientId)) {
        collaborators.delete(collaboratorClientId);
        membershipChanged = true;
      }
    }
    if (membershipChanged) applyCollaborators();

    // Upstream NEW_USER handshake: existing members hand a fresh snapshot to
    // every newcomer so a joining client converges without editing first.
    const hasNewPeer = peers.some(
      (peer) => peer.peerId !== selfPeerId && !previousPeerIds.has(peer.peerId),
    );
    if (hasNewPeer) sendFullScene();
  };

  const subscriber: TransportSubscriber = {
    onConnectionStateChange: handleConnectionStateChange,
    onMessage: handleRemoteMessage,
    onRoomPeersChange: handleRoomPeersChange,
  };
  const unsubscribe = transport.subscribe(subscriber);

  return {
    connect() {
      if (destroyed) throw new Error("Collaboration session is destroyed");
      transport.connect({ roomId, clientId, joinToken });
    },
    disconnect() {
      transport.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelPendingFlush?.();
      cancelPendingFlush = undefined;
      unsubscribe();
    },
    handleLocalSceneChange(_elements, appState) {
      if (destroyed) return;
      lastSelectedElementIds = Object.keys(appState.selectedElementIds)
        .filter((id) => id.length <= MAX_PRESENCE_ELEMENT_ID_LENGTH)
        .slice(0, MAX_PRESENCE_SELECTED_ELEMENT_IDS);
      // The flush reads the live scene from the API at send time, so
      // coalesced onChange bursts serialize the scene at most once per frame.
      scheduleFlush();
    },
    handlePointerUpdate(payload) {
      if (destroyed) return;
      lastPointer = {
        x: payload.pointer.x,
        y: payload.pointer.y,
        tool: payload.pointer.tool,
      };
      lastButton = payload.button;
      // Leading-edge throttle without timers: presence is volatile, so a
      // dropped trailing sample is repaired by the next pointer event.
      if (now() - lastPresenceSentAt >= presenceThrottleMs) sendPresence();
    },
    setIdleState(nextIdleState) {
      if (destroyed || idleState === nextIdleState) return;
      idleState = nextIdleState;
      // Idle transitions are rare and user-visible: bypass the throttle.
      sendPresence();
    },
    getConnectionState() {
      return transport.getConnectionState();
    },
  };
}
