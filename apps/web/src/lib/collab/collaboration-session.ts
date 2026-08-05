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
import {
  createJoinBarrier,
  DEFAULT_JOIN_BASELINE_TIMEOUT_MS,
  electSnapshotResponder,
  type JoinBarrier,
  type JoinBarrierOptions,
} from "@drawstuff/collaboration/join-barrier";
import { roomRoleCanEditScene } from "@drawstuff/collaboration/room-auth";
import {
  collaborationSnapshotDigest,
  electSnapshotWriter,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";
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

import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";

/**
 * Mirrors the upstream collab app's cadence: deltas coalesce per animation
 * frame, presence is throttled to ~30fps (`CURSOR_SYNC_TIMEOUT`), and a full
 * snapshot is rebroadcast at most every 20s while edits happen
 * (`SYNC_FULL_SCENE_INTERVAL_MS`) so dropped deltas always heal.
 */
export const FULL_SCENE_SYNC_INTERVAL_MS = 20_000;
export const PRESENCE_THROTTLE_MS = 33;

/**
 * How often the elected writer publishes the durable snapshot. Much slower than
 * the realtime cadence on purpose: the snapshot is what a *later* joiner needs,
 * not what live peers need, and every write is a database round-trip plus a
 * full-scene seal.
 */
export const SNAPSHOT_INTERVAL_MS = 30_000;

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
   * Durable baseline for this room generation. Absent means the session runs on
   * live peers alone — used by tests that exercise peer sync in isolation.
   */
  snapshotStore?: CollaborationSnapshotStore;
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
   * Schedules a one-shot timer and returns its cancel function. Owns the join
   * baseline deadline and the snapshot cadence; tests inject a manual clock so
   * neither depends on wall time.
   */
  scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
  /**
   * Checked synchronously before every scene read or write. When it returns
   * false the canvas no longer holds this room's scene, so the session neither
   * broadcasts what is on it nor applies room traffic to it. Presence is
   * unaffected: it carries no scene state.
   */
  canSyncScene?: () => boolean;
  /** Reported once per connection when the join baseline resolves. */
  onBaselineResolved?: (outcome: BaselineOutcome) => void;
  now?: () => number;
  fullSceneSyncIntervalMs?: number;
  presenceThrottleMs?: number;
  snapshotIntervalMs?: number;
  joinBaselineTimeoutMs?: number;
  joinBarrier?: JoinBarrierOptions;
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
  /**
   * Publishes the durable snapshot now, ignoring the cadence. Called when the
   * last participant leaves so the room's state survives the room emptying out.
   * Resolves when the write settles; the caller may await it before tearing the
   * session down.
   */
  flushSnapshot(): Promise<void>;
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

const defaultScheduleTimeout = (
  run: () => void,
  delayMs: number,
): (() => void) => {
  const timerId = setTimeout(run, delayMs);
  return () => clearTimeout(timerId);
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
    snapshotStore,
    wrapRemoteApply = (apply) => {
      apply();
    },
    scheduleSceneFlush = defaultScheduleSceneFlush,
    scheduleTimeout = defaultScheduleTimeout,
    onBaselineResolved,
    now = Date.now,
    fullSceneSyncIntervalMs = FULL_SCENE_SYNC_INTERVAL_MS,
    presenceThrottleMs = PRESENCE_THROTTLE_MS,
    snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
    joinBaselineTimeoutMs = DEFAULT_JOIN_BASELINE_TIMEOUT_MS,
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
  let roomPeers: readonly RoomPeer[] = [];

  /**
   * Advanced on every connect. Async work started for one connection checks it
   * before touching session state, so a snapshot load or write that settles
   * after a reconnect (or after `destroy`) is dropped instead of applied to a
   * session it no longer belongs to.
   */
  let joinEpoch = 0;

  /** Present only while the join barrier is holding inbound scene traffic. */
  let barrier: JoinBarrier | undefined;
  let cancelBaselineTimeout: (() => void) | undefined;

  let cancelSnapshotCadence: (() => void) | undefined;
  /** Last revision this session knows the durable snapshot to be at. */
  let snapshotRevision = SNAPSHOT_NO_REVISION;
  /**
   * Whether this session established what the room's baseline currently is.
   *
   * Only a client that knows the baseline may replace it. Without this a session
   * that could not read the stored snapshot — a link carrying the wrong key, or a
   * failed fetch in an empty room — would see an empty canvas, learn the real
   * revision from its first conflict, and then overwrite the room's history with
   * that empty canvas. Refusing to write is the safe direction: the room keeps a
   * baseline this client cannot read, which is exactly the truth of the
   * situation.
   */
  let snapshotBaselineKnown = false;
  /** Digest of the element set last written, so an idle room writes nothing. */
  let lastSnapshotDigest: string | undefined;
  let snapshotWriteInFlight = false;
  /** The write currently settling, so a leave flush can queue behind it. */
  let inFlightWrite: Promise<void> | undefined;

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
    // Nothing may be published before the baseline lands: until then this canvas
    // is not yet the room's scene, and broadcasting it would push pre-join local
    // state into the room.
    if (barrier || !connected || !canEditScene()) return;
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
    // Local edits made during the join window are not lost: the tracker still
    // holds them (nothing was marked sent), and the snapshot broadcast that
    // follows the baseline carries them.
    if (barrier || !connected || !canEditScene()) return;
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

  /**
   * Merges remote elements into the canvas through the adapter's upstream
   * reconciliation boundary. The single write path for every source of remote
   * state: peer deltas, peer snapshots and the durable snapshot.
   */
  const applyRemoteElements = (elements: readonly SyncedElement[]): void => {
    // The canvas may have been replaced by another scene since this state was
    // produced; applying room state to it would corrupt that scene.
    if (!canSyncScene()) return;
    wrapRemoteApply(() => {
      const localElements = sceneApi.getSceneElementsIncludingDeleted();
      const reconciled = reconcileRemoteElements(
        localElements,
        elements as unknown as readonly ExcalidrawElement[],
        sceneApi.getAppState(),
      );
      sceneApi.updateScene({
        elements: reconciled,
        captureUpdate: EXCALIDRAW_CAPTURE_UPDATE_ACTION.NEVER,
      });
      tracker.markAdoptedRemoteElements(reconciled, elements);
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

  const deliverSceneMessage = (
    message: SceneMessage,
    sceneSyncRequired: boolean,
  ): void => {
    applyRemoteElements(message.payload.elements);
    if (message.type === "scene-init") {
      if (sceneInitNeedsReply(message.payload.elements)) sendFullScene();
      return;
    }
    // A sequence gap means we missed deltas from this sender. Broadcasting
    // our snapshot triggers the sender's scene-init reply above, which
    // carries the state we missed; the throttled full sync is the backstop.
    if (sceneSyncRequired) sendFullScene();
  };

  const clearBaselineTimeout = (): void => {
    cancelBaselineTimeout?.();
    cancelBaselineTimeout = undefined;
  };

  /**
   * Opens the barrier: replays what it held, in arrival order, then publishes
   * our own snapshot so the rest of the room converges with us.
   *
   * Replay applies elements only — it deliberately does not run the per-message
   * snapshot-reply probe, because the single broadcast at the end is that probe,
   * and running it per replayed message would answer one join with a burst.
   */
  const releaseBarrier = (outcome: BaselineOutcome): void => {
    const releasing = barrier;
    if (!releasing) return;
    clearBaselineTimeout();
    const held = releasing.release();
    barrier = undefined;
    for (const message of held) {
      applyRemoteElements(message.payload.elements);
    }
    onBaselineResolved?.(outcome);
    // Also the repair for a buffer that overflowed: our snapshot draws the
    // peers' snapshot replies, which carry whatever the drop lost.
    sendFullScene();
    // A viewer cannot publish, so the line above is not a repair for it. Re-read
    // the durable baseline instead, which recovers everything up to the last
    // stored snapshot without needing a frame the relay would refuse. Edits
    // newer than that snapshot still depend on a peer's periodic full sync; a
    // read-only sync request is the complete answer and belongs to Plan 18's
    // recovery state machine.
    if (releasing.needsSceneSync() && !canEditScene()) {
      void loadDurableBaseline(joinEpoch);
    }
  };

  /**
   * Reads the durable baseline, merges it into the canvas, and — if it is the
   * first baseline to arrive — opens the join barrier with it.
   *
   * At join time it races the elected peer's snapshot deliberately, and whichever
   * wins is accepted. An earlier design preferred the peer and made the stored
   * baseline wait, which read as "always use the freshest state" but deadlocked
   * the case that matters most: two clients joining an empty room at the same
   * moment each saw the other as its responder and both stalled until the
   * deadline. Racing is also simply better — the loser's snapshot still arrives
   * moments later as ordinary traffic and reconciles, so the only difference is
   * how fast the canvas paints.
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
    if (destroyed || epoch !== joinEpoch) return;

    if (result.status === "loaded") {
      applyRemoteElements(result.elements);
      snapshotRevision = result.revision;
      snapshotBaselineKnown = true;
      if (barrier?.claimBaseline()) releaseBarrier("durable-snapshot");
      return;
    }
    if (result.status === "empty") {
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = true;
      if (barrier?.claimBaseline()) releaseBarrier("empty");
      return;
    }
    // The baseline stays unknown, and `writeSnapshot` refuses while it is:
    // replacing a snapshot we could not read would destroy room history on the
    // strength of a canvas we have no reason to believe is complete.
    snapshotBaselineKnown = false;
    if (barrier?.claimBaseline()) {
      releaseBarrier(
        result.reason === "wrong-key"
          ? "unreadable-snapshot"
          : "snapshot-unavailable",
      );
    }
  };

  const openBarrier = (epoch: number): void => {
    barrier = createJoinBarrier(options.joinBarrier);
    // Backstop for a store that never answers at all: the barrier must not hold
    // inbound traffic — or the canvas — indefinitely.
    cancelBaselineTimeout = scheduleTimeout(() => {
      cancelBaselineTimeout = undefined;
      if (epoch !== joinEpoch || !barrier?.claimBaseline()) return;
      releaseBarrier("snapshot-unavailable");
    }, joinBaselineTimeoutMs);
    void loadDurableBaseline(epoch);
  };

  const isElectedSnapshotWriter = (): boolean =>
    connected !== undefined &&
    electSnapshotWriter(roomPeers)?.peerId === connected.peerId;

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
    // A leave flush queues behind the cadence write rather than dropping.
    if (force && inFlightWrite) {
      await inFlightWrite.catch(() => undefined);
    }
    if (
      (destroyed && !force) ||
      !snapshotStore ||
      !snapshotBaselineKnown ||
      (snapshotWriteInFlight && !force) ||
      !connected ||
      barrier ||
      !canEditScene() ||
      (!force && !isElectedSnapshotWriter())
    ) {
      return;
    }
    const store = snapshotStore;
    const epoch = joinEpoch;
    // Captured once. The forced retry below reuses these rather than re-reading
    // the canvas, which by then may no longer belong to the room.
    const elements = getSyncableElements(
      sceneApi.getSceneElementsIncludingDeleted(),
      now(),
    ) as unknown as readonly SyncedElement[];
    const digest = await collaborationSnapshotDigest(elements);
    if ((destroyed && !force) || epoch !== joinEpoch) return;
    if (digest === lastSnapshotDigest && !force) return;

    const run = async (): Promise<void> => {
      const result = await store.save({
        elements,
        expectedRevision: snapshotRevision,
      });
      // A write that settles after a reconnect must not seed the new session's
      // revision with the old one's answer.
      if (epoch !== joinEpoch) return;
      if (result.status === "written") {
        snapshotRevision = result.revision;
        lastSnapshotDigest = digest;
        return;
      }
      if (result.status !== "conflict") return;

      // Not just the revision: the winner stored elements this client has not
      // read, so claiming to supersede them without merging would erase them.
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
      snapshotRevision = result.currentRevision ?? SNAPSHOT_NO_REVISION;

      if (!force) {
        // The next cadence tick is the retry, so all that is needed here is for
        // this client to learn what it lost to.
        if (!destroyed) await loadDurableBaseline(epoch);
        return;
      }

      // Forced: there is no next tick. Merge the winner with the captured scene
      // and retry exactly once. The merge runs through the adapter's upstream
      // reconciliation rather than the canvas, because the canvas may already be
      // gone — and because the result has to contain *both* sides.
      const winner = await store.load();
      if (epoch !== joinEpoch || winner.status !== "loaded") return;
      const merged = reconcileRemoteElements(
        elements as unknown as readonly OrderedExcalidrawElement[],
        winner.elements as unknown as readonly ExcalidrawElement[],
        sceneApi.getAppState(),
      ) as unknown as readonly SyncedElement[];
      const retried = await store.save({
        elements: merged,
        expectedRevision: winner.revision,
      });
      if (epoch !== joinEpoch) return;
      if (retried.status === "written") {
        snapshotRevision = retried.revision;
        snapshotBaselineKnown = true;
      }
    };

    snapshotWriteInFlight = true;
    const write = run();
    inFlightWrite = write;
    try {
      await write;
    } finally {
      snapshotWriteInFlight = false;
      if (inFlightWrite === write) inFlightWrite = undefined;
    }
  };

  const stopSnapshotCadence = (): void => {
    cancelSnapshotCadence?.();
    cancelSnapshotCadence = undefined;
  };

  const startSnapshotCadence = (epoch: number): void => {
    stopSnapshotCadence();
    if (!snapshotStore) return;
    const tick = (): void => {
      cancelSnapshotCadence = undefined;
      if (destroyed || epoch !== joinEpoch) return;
      // "I do not know the baseline" disables writing, which is the safe
      // direction — but it must not be permanent. A snapshot fetch that failed
      // once at join time would otherwise leave the elected writer unable to
      // ever persist the room again, so the read is retried here at the same
      // bounded cadence. A genuinely unreadable snapshot simply keeps failing,
      // which correctly keeps writing disabled.
      if (snapshotBaselineKnown) {
        void writeSnapshot();
      } else {
        void loadDurableBaseline(epoch);
      }
      // Re-armed after each tick rather than as an interval, so a slow write
      // can never queue overlapping ticks.
      cancelSnapshotCadence = scheduleTimeout(tick, snapshotIntervalMs);
    };
    cancelSnapshotCadence = scheduleTimeout(tick, snapshotIntervalMs);
  };

  const handleRemoteMessage = (
    message: CollaborationMessage,
    meta: { byteLength: number },
  ): void => {
    if (!connected || !gate) return;
    const verdict = gate.accept(message);
    if (verdict.action === "reject") return;

    if (message.type === "presence") {
      // Presence never enters the barrier: it carries no scene state, so holding
      // it would only make other people's cursors lag behind the join.
      collaborators.set(message.senderClientId, toCollaborator(message));
      applyCollaborators();
      return;
    }

    if (barrier) {
      // The first snapshot to arrive is the baseline, whoever sent it. Later
      // snapshots (two responders briefly disagreeing about who answers) are
      // ordinary traffic, which is what makes duplicate replies harmless.
      if (message.type === "scene-init" && barrier.claimBaseline()) {
        applyRemoteElements(message.payload.elements);
        releaseBarrier("peer");
        return;
      }
      barrier.hold(message, meta.byteLength);
      return;
    }

    deliverSceneMessage(message, verdict.sceneSyncRequired);
  };

  const handleConnectionStateChange = (state: ConnectionState): void => {
    if (state.status === "connected") {
      joinEpoch += 1;
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
      roomPeers = [{ peerId: state.peerId, clientId: state.clientId, role: state.role }];
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
      // Subscribe first, then obtain a baseline: an edit published between a
      // baseline fetch and a subscription would be in neither, and nothing later
      // would reveal that it is missing.
      openBarrier(joinEpoch);
      startSnapshotCadence(joinEpoch);
      return;
    }
    connected = undefined;
    gate = undefined;
    roomPeers = [];
    barrier?.dispose();
    barrier = undefined;
    clearBaselineTimeout();
    stopSnapshotCadence();
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
    roomPeers = peers;

    const activeClientIds = new Set(peers.map((peer) => peer.clientId));
    let membershipChanged = false;
    for (const collaboratorClientId of [...collaborators.keys()]) {
      if (!activeClientIds.has(collaboratorClientId)) {
        collaborators.delete(collaboratorClientId);
        membershipChanged = true;
      }
    }
    if (membershipChanged) applyCollaborators();

    // A member still waiting for its own baseline has nothing to hand out.
    if (barrier) return;

    // Upstream's NEW_USER handshake has every member hand a snapshot to every
    // newcomer. One elected responder is enough, and the newcomer's barrier
    // dedups if two of us briefly disagree about who that is.
    const newPeerIds = new Set(
      peers
        .filter((peer) => !previousPeerIds.has(peer.peerId))
        .map((peer) => peer.peerId),
    );
    if (newPeerIds.size === 0) return;
    const responder = electSnapshotResponder({ peers, newPeerIds });
    if (responder?.peerId === selfPeerId) sendFullScene();
  };

  const subscriber: TransportSubscriber = {
    onConnectionStateChange: handleConnectionStateChange,
    onMessage: handleRemoteMessage,
    onRoomPeersChange: handleRoomPeersChange,
    // The transport dropped inbound scene traffic, so this side may be behind
    // with no sequence gap to detect. Our snapshot draws the sender's
    // `scene-init` reply (see `sceneInitNeedsReply`), which carries whatever we
    // lost — the same repair path a detected gap uses.
    onSceneSyncRequired: sendFullScene,
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
      barrier?.dispose();
      barrier = undefined;
      clearBaselineTimeout();
      stopSnapshotCadence();
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
    flushSnapshot() {
      return writeSnapshot({ force: true });
    },
    getConnectionState() {
      return transport.getConnectionState();
    },
  };
}
