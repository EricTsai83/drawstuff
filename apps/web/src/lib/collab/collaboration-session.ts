import {
  PRESENCE_THROTTLE_MS,
  SCENE_FLUSH_BACKSTOP_MS,
} from "@drawstuff/collaboration/client-pacing";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createInboundMessageGate,
  type InboundMessageGate,
  type PeerId,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import {
  DEFAULT_JOIN_BASELINE_TIMEOUT_MS,
  electSnapshotResponder,
  type JoinBarrierOptions,
} from "@drawstuff/collaboration/join-barrier";
import {
  createOfflineChangeQueue,
  type OfflineChangeQueueOptions,
} from "@drawstuff/collaboration/offline-queue";
import {
  createRecoveryMachine,
  type RecoveryPolicyOptions,
  type RecoveryState,
} from "@drawstuff/collaboration/recovery";
import { roomRoleCanEditScene } from "@drawstuff/collaboration/room-auth";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
  TransportSubscriber,
} from "@drawstuff/collaboration/transport";
import { createChangedElementTracker } from "@drawstuff/excalidraw-adapter/reconcile";
import type {
  AppState,
  BinaryFileData,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import type { CollaborationAssetStore } from "@/lib/collab/asset-store";
import { createAssetBridge } from "@/lib/collab/session/asset-bridge";
import {
  createConnectionLifecycle,
  type JoinCredentialsResult,
} from "@/lib/collab/session/connection-lifecycle";
import {
  createJoinBaselineGate,
  type BaselineOutcome,
} from "@/lib/collab/session/join-baseline";
import {
  createPresenceChannel,
  type CollaborationIdleState,
  type FollowHost,
  type PresenceViewBounds,
  type PresenceViewZoom,
} from "@/lib/collab/session/presence-channel";
import { createRemoteApplier } from "@/lib/collab/session/remote-apply";
import { createScenePublisher } from "@/lib/collab/session/scene-publisher";
import { createSceneRepair } from "@/lib/collab/session/scene-repair";
import {
  createSnapshotCadence,
  type SnapshotCadence,
} from "@/lib/collab/session/snapshot-cadence";
import {
  createSyncBlockReporter,
  type SceneSyncBlock,
} from "@/lib/collab/session/sync-block-reporter";
import type {
  BuildEnvelope,
  CollaborationSceneApi,
  ConnectedState,
  MessageEnvelope,
} from "@/lib/collab/session/session-context";
import type { SessionContext } from "@/lib/collab/session/session-context";
import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";

export type { JoinCredentialsResult } from "@/lib/collab/session/connection-lifecycle";
export type { BaselineOutcome } from "@/lib/collab/session/join-baseline";
export type {
  FollowHost,
  PresenceViewBounds,
} from "@/lib/collab/session/presence-channel";
export type { CollaborationSceneApi } from "@/lib/collab/session/session-context";
export type { SceneSyncBlock } from "@/lib/collab/session/sync-block-reporter";

/**
 * The collaboration session, assembled.
 *
 * Mirrors the upstream collab app's cadence: deltas coalesce per animation
 * frame, presence is throttled to ~30fps (`PRESENCE_THROTTLE_MS`, imported
 * from the shared client-pacing contract the relay's rate budgets are sized
 * against), and a full snapshot is rebroadcast at most every 20s while edits
 * happen (`SYNC_FULL_SCENE_INTERVAL_MS`) so dropped deltas always heal.
 *
 * This module is the orchestrator: it owns the connection state, the teardown
 * flags and the epochs, builds the `SessionContext` the parts read them
 * through, and wires the parts together. The behaviour lives in `session/`:
 * outbound scene traffic in `scene-publisher`, inbound in `remote-apply`, the
 * join exchange in `join-baseline`, the durable snapshot in `snapshot-cadence`,
 * presence in `presence-channel`, reconnects in `connection-lifecycle`, the
 * publish-loss backstop in `scene-repair`, asset wiring in `asset-bridge`, and
 * the size-block report in `sync-block-reporter`.
 */
export const FULL_SCENE_SYNC_INTERVAL_MS = 20_000;

/**
 * How often the elected writer publishes the durable snapshot. Much slower than
 * the realtime cadence on purpose: the snapshot is what a *later* joiner needs,
 * not what live peers need, and every write is a database round-trip plus a
 * full-scene seal.
 */
export const SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * Consecutive scene repairs a session will attempt with no sign of room activity
 * in between (see `scene-repair.ts`).
 *
 * Small on purpose. One repair already covers a single dropped message, which is
 * the realistic case; the extra attempts cover a repair that is itself dropped.
 * Past this the room is treated as quiet and the session stops publishing, because
 * the alternative is a permanent full-scene heartbeat from every member.
 */
const MAX_SCENE_REPAIR_ATTEMPTS = 3;

const MAX_MESSAGE_ID_LENGTH = 64;

export type CollaborationSessionOptions = {
  transport: CollaborationTransport;
  roomId: RoomId;
  /**
   * Short-lived join token from `collaborationRoom.join`, already minted for the
   * first attempt. The session never decides its own role: the granted role comes
   * back in the connected state.
   */
  joinToken: string;
  /**
   * The room's durable authorization generation this session's keys are derived
   * from. Compared against every refreshed token so a rotation is detected as a
   * rotation instead of as a stream of undecryptable frames.
   */
  authGeneration: number;
  /** Mints credentials for a reconnect attempt; see `connection-lifecycle.ts`. */
  refreshJoinToken: () => Promise<JoinCredentialsResult>;
  /**
   * Display name carried in presence. Empty means unnamed: the session falls
   * back to `guest-<peerId suffix>` per connection, because the peer id — the
   * only collaboration identity — is assigned by the relay and
   * does not exist until the join completes.
   */
  username: string;
  sceneApi: CollaborationSceneApi;
  /**
   * Durable baseline for this room generation. Absent means the session runs on
   * live peers alone — used by tests that exercise peer sync in isolation.
   */
  snapshotStore?: CollaborationSnapshotStore;
  /**
   * Encrypted transfer for the binary assets the scene's image elements
   * reference. Absent means images are not exchanged — used by tests that
   * exercise element sync in isolation, which is also the honest description of
   * what a session without it does.
   */
  assetStore?: CollaborationAssetStore;
  /**
   * Every canvas write triggered by remote input (scene deltas, snapshots and
   * presence) runs through this wrapper, so the host can suppress its own
   * `onChange` side effects (dirty tracking) for the write. Defaults to a
   * plain call.
   */
  wrapRemoteApply?: (apply: () => void) => void;
  /**
   * Presence-only canvas writes (the collaborator map) run through this wrapper
   * instead of `wrapRemoteApply`. They carry no scene state, so a host whose
   * remote-apply wrapper defers its cleanup (dirty-tracking suppression released
   * a frame later) can pass a synchronous wrapper here — presence arrives at
   * ~30fps per peer, and deferred windows at that rate overlap without end.
   * Defaults to `wrapRemoteApply`.
   */
  wrapPresenceApply?: (apply: () => void) => void;
  /**
   * Engine-facing half of follow mode: moves the local viewport to a followed
   * peer's center and absolute zoom, and keeps the engine's follow state
   * truthful. Absent means follow mode is inert — presence still carries
   * viewport and follow state, but nothing moves this client's viewport
   * (headless tests).
   */
  followHost?: FollowHost;
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
  /**
   * Reported whenever the set of size-blocked publish paths changes, and `null`
   * once every path is publishing again. See `SceneSyncBlock`: this is the only
   * signal that distinguishes a session that is syncing from one that is merely
   * still connected, so a caller that shows "collaborating" has to consume it.
   */
  onSceneSyncBlockChange?: (block: SceneSyncBlock | null) => void;
  /**
   * Reported on every recovery phase change, including the terminal ones. This
   * is the session's honest connection status: `getConnectionState()` describes
   * the socket, this describes whether the room is coming back.
   */
  onRecoveryStateChange?: (state: RecoveryState) => void;
  now?: () => number;
  fullSceneSyncIntervalMs?: number;
  presenceThrottleMs?: number;
  snapshotIntervalMs?: number;
  joinBaselineTimeoutMs?: number;
  maxSceneRepairAttempts?: number;
  joinBarrier?: JoinBarrierOptions;
  offlineQueue?: OfflineChangeQueueOptions;
  recovery?: RecoveryPolicyOptions;
};

export type CollaborationSession = {
  /**
   * Starts the first connection attempt and arms recovery. Subsequent attempts
   * are the session's own business: a dropped socket reconnects with backoff and
   * a freshly minted token until it succeeds or hits a terminal condition.
   */
  connect(): void;
  /** Leaves the room and disarms recovery; `connect()` may be called again. */
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
  /** Wire to the editor `onScrollChange`: shares the local visible scene
   *  bounds and absolute zoom so peers following this client can move with it. */
  handleViewportChange(
    bounds: PresenceViewBounds,
    zoom: PresenceViewZoom,
  ): void;
  /** Wire to the editor `onUserFollow`: mirrors the engine's follow target
   *  into presence and snaps to the target's last known viewport. */
  handleUserFollow(targetPeerId: PeerId | null): void;
  /**
   * Injects assets the asset store opened. Wired as the store's callback rather
   * than pulled by the session, because a download settles whenever it settles —
   * long after the element that referenced it was applied.
   */
  applyRemoteAssets(files: readonly BinaryFileData[]): void;
  /**
   * Marks the image elements whose bytes this client will never obtain, so the
   * canvas draws the engine's error placeholder rather than the loading one.
   *
   * Wired as the asset store's callback for the same reason `applyRemoteAssets`
   * is: giving up on a download settles whenever it settles, long after the
   * element that referenced it was applied.
   */
  applyUnavailableAssets(fileIds: readonly string[]): void;
  /**
   * Re-offers the canvas's current images to the asset store. Wired to the store's
   * upload-retry timer: a retry has to read the scene again, because the image
   * that failed to upload may have been deleted since.
   */
  republishLocalAssets(): void;
  setIdleState(idleState: CollaborationIdleState): void;
  /**
   * Publishes the durable snapshot now, ignoring the cadence. Called when the
   * last participant leaves so the room's state survives the room emptying out.
   * Resolves when the write settles; the caller may await it before tearing the
   * session down.
   */
  flushSnapshot(): Promise<void>;
  getConnectionState(): ConnectionState;
  /** Current recovery phase; see `onRecoveryStateChange`. */
  getRecoveryState(): RecoveryState;
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
    joinToken,
    authGeneration,
    refreshJoinToken,
    username,
    sceneApi,
    snapshotStore,
    assetStore,
    wrapRemoteApply = (apply) => {
      apply();
    },
    wrapPresenceApply = wrapRemoteApply,
    scheduleSceneFlush = defaultScheduleSceneFlush,
    scheduleTimeout = defaultScheduleTimeout,
    onBaselineResolved,
    onRecoveryStateChange,
    onSceneSyncBlockChange,
    now = Date.now,
    fullSceneSyncIntervalMs = FULL_SCENE_SYNC_INTERVAL_MS,
    presenceThrottleMs = PRESENCE_THROTTLE_MS,
    snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
    joinBaselineTimeoutMs = DEFAULT_JOIN_BASELINE_TIMEOUT_MS,
    maxSceneRepairAttempts = MAX_SCENE_REPAIR_ATTEMPTS,
    canSyncScene = () => true,
  } = options;

  let destroyed = false;
  /**
   * Set once recovery reached a terminal state. Distinct from `destroyed`, which
   * is the caller's teardown: a terminated session is still owned by a caller
   * that has not torn it down yet, and it must stop doing work in the meantime
   * rather than keep walking the scene on every `onChange`.
   */
  let terminated = false;
  /**
   * Assigned once the transport subscription exists. Released by `terminate` as
   * well as by `destroy`, and idempotent, because a terminal state may be reached
   * from inside the transport callback that is delivering it.
   */
  let unsubscribeTransport: (() => void) | undefined;
  let connected: ConnectedState | undefined;
  let gate: InboundMessageGate | undefined;
  let knownPeerIds = new Set<string>();
  let roomPeers: readonly RoomPeer[] = [];
  /**
   * Advanced on every connect. Async work started for one connection checks it
   * before touching session state, so a snapshot load or write that settles
   * after a reconnect (or after `destroy`) is dropped instead of applied to a
   * session it no longer belongs to.
   */
  let joinEpoch = 0;

  const tracker = createChangedElementTracker();
  // The session's clock is also the recovery machine's clock unless the
  // caller separates them: the live-stability window must measure time on the
  // same source as the deadlines around it, and tests drive one clock for both.
  const recovery = createRecoveryMachine({
    now: options.now,
    ...options.recovery,
  });
  /**
   * Bounded accounting of what changed while the session was down, and the only
   * thing that decides whether a reconnect can be a delta.
   */
  const offlineQueue = createOfflineChangeQueue(options.offlineQueue);

  const context: SessionContext = {
    get connected() {
      return connected;
    },
    canEditScene: () =>
      connected !== undefined &&
      roomRoleCanEditScene(connected.role) &&
      canSyncScene(),
    canSyncScene,
    isStopped: () => destroyed || terminated,
    now,
    scheduleTimeout,
    sceneApi,
  };

  let messageCounter = 0;
  const nextMessageId = (): string => {
    messageCounter += 1;
    const peerId = connected?.peerId ?? "detached";
    return `m${messageCounter}-${peerId}`.slice(0, MAX_MESSAGE_ID_LENGTH);
  };
  const buildEnvelope: BuildEnvelope = (
    session,
    sequence,
  ): MessageEnvelope => ({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    messageId: nextMessageId(),
    roomId: session.roomId,
    roomGeneration: session.roomGeneration,
    senderPeerId: session.peerId,
    sequence,
  });

  const reporter = createSyncBlockReporter(onSceneSyncBlockChange);

  const repair = createSceneRepair({
    context,
    maxAttempts: maxSceneRepairAttempts,
    intervalMs: fullSceneSyncIntervalMs,
    requestFlush: () => publisher.scheduleFlush(),
  });

  const bridge = createAssetBridge({
    context,
    assetStore,
    isDestroyed: () => destroyed,
    wrapRemoteApply,
  });

  const publisher = createScenePublisher({
    context,
    transport,
    tracker,
    offlineQueue,
    buildEnvelope,
    scheduleSceneFlush,
    fullSceneSyncIntervalMs,
    hasBarrier: () => joinBaseline.hasBarrier(),
    publishLocalAssets: () => bridge.publishLocalAssets(),
    armSceneRepair: () => repair.arm(),
    reporter,
    failRecovery: (reason) => lifecycle.failRecovery(reason),
  });

  const cadence: SnapshotCadence = createSnapshotCadence({
    context,
    snapshotStore,
    snapshotIntervalMs,
    getJoinEpoch: () => joinEpoch,
    isDestroyed: () => destroyed,
    isTerminated: () => terminated,
    hasBarrier: () => joinBaseline.hasBarrier(),
    getRoomPeers: () => roomPeers,
    loadDurableBaseline: (epoch) => joinBaseline.loadDurableBaseline(epoch),
    reporter,
  });

  const joinBaseline = createJoinBaselineGate({
    context,
    snapshotStore,
    joinBarrierOptions: options.joinBarrier,
    joinBaselineTimeoutMs,
    offlineQueue,
    recovery,
    notifyRecovery: () => lifecycle.notifyRecovery(),
    onBaselineResolved,
    getJoinEpoch: () => joinEpoch,
    isDestroyed: () => destroyed,
    applyRemoteElements: (elements) =>
      remoteApplier.applyRemoteElements(elements),
    sendFullScene: () => publisher.sendFullScene(),
    sendSceneDelta: () => publisher.sendSceneDelta(),
    markFullSceneSyncedNow: () => publisher.markFullSceneSyncedNow(),
    armSceneRepair: () => repair.arm(),
    publishLocalAssets: () => bridge.publishLocalAssets(),
    snapshotBaseline: cadence,
    failRecovery: (reason) => lifecycle.failRecovery(reason),
  });

  const presence = createPresenceChannel({
    context,
    transport,
    buildEnvelope,
    username,
    presenceThrottleMs,
    wrapPresenceApply,
    scheduleSceneFlush,
    failRecovery: (reason) => lifecycle.failRecovery(reason),
    follow: options.followHost,
  });

  const remoteApplier = createRemoteApplier({
    context,
    tracker,
    wrapRemoteApply,
    getGate: () => gate,
    isKnownPeer: (peerId) => knownPeerIds.has(peerId),
    receivePresence: (message) => presence.receivePresence(message),
    interceptSceneMessage: (message, byteLength) =>
      joinBaseline.interceptSceneMessage(message, byteLength),
    requestMissingAssets: (elements) => bridge.requestMissingAssets(elements),
    noteRoomActivity: () => repair.noteRoomActivity(),
    sendFullScene: () => publisher.sendFullScene(),
  });

  const lifecycle = createConnectionLifecycle({
    transport,
    roomId,
    authGeneration,
    initialToken: joinToken,
    refreshJoinToken,
    recovery,
    scheduleTimeout,
    isDestroyed: () => destroyed,
    isTerminated: () => terminated,
    markTerminated: () => {
      terminated = true;
    },
    // Everything a terminal state must stop beyond the lifecycle's own timer and
    // attempt epoch. The connection state is cleared here rather than in the
    // subscriber: a transport that reports the drop asynchronously (or not at
    // all) must not leave a terminated session holding `connected`, a live
    // barrier, or peers' cursors on the canvas.
    teardown: () => {
      // Abandons any snapshot load or write still in flight. Those are guarded
      // by `joinEpoch`, not the attempt epoch, so without this a durable load
      // issued during the join could still resolve afterwards and write the
      // room's elements onto the canvas of a session that has already stopped.
      joinEpoch += 1;
      publisher.cancelPendingFlush();
      repair.clear();
      joinBaseline.dispose();
      cadence.stop();
      offlineQueue.clear();
      // Unsubscribed *before* the disconnect; see above.
      unsubscribeTransport?.();
      unsubscribeTransport = undefined;
      transport.disconnect();
      connected = undefined;
      gate = undefined;
      roomPeers = [];
      presence.clear();
    },
    onRecoveryStateChange,
  });

  const handleConnectionStateChange = (state: ConnectionState): void => {
    // The socket is open but has not joined yet: no session state exists to set
    // up and none to tear down.
    if (state.status === "connecting") return;
    if (state.status === "connected") {
      // Always `connecting` here: every socket this session has is opened by
      // `beginAttempt` or `reconnect`, both of which enter that phase first. The
      // check exists so a transport driven from outside the session cannot push
      // the machine through an illegal transition and throw inside a subscriber
      // callback — it is not a second way to become live.
      if (recovery.state().phase === "connecting") {
        recovery.connected();
        lifecycle.notifyRecovery();
      }
      joinEpoch += 1;
      connected = state;
      gate = createInboundMessageGate({
        roomId: state.roomId,
        roomGeneration: state.roomGeneration,
      });
      tracker.reset();
      publisher.resetForConnection();
      presence.resetForConnection();
      // A new socket owes the room a real asset offer, not a cache hit: an
      // upload refused while the session was down consumed its retry timer.
      bridge.resetOfferCache();
      // A new socket owes the room a real asset offer, not a cache hit: an
      // upload refused while the session was down consumed its retry timer.
      knownPeerIds = new Set([state.peerId]);
      roomPeers = [{ peerId: state.peerId, role: state.role }];
      cadence.resetForConnection();
      repair.noteRoomActivity();
      // Subscribe first, then obtain a baseline: an edit published between a
      // baseline fetch and a subscription would be in neither, and nothing later
      // would reveal that it is missing.
      joinBaseline.openBarrier(joinEpoch);
      cadence.start(joinEpoch);
      return;
    }
    connected = undefined;
    gate = undefined;
    roomPeers = [];
    joinBaseline.dispose();
    cadence.stop();
    // Nothing to repair while there is no session: the offline queue takes over,
    // and the rejoin publish is what brings the room up to date.
    repair.clear();
    presence.clear();
    bridge.resetOfferCache();
    if (state.status === "disconnected") {
      lifecycle.handleConnectionLoss(state.reason);
      return;
    }
    // The transport is closed for good, so there is nothing left to recover.
    lifecycle.clearReconnectTimer();
    recovery.stop();
    lifecycle.notifyRecovery();
  };

  const handleRoomPeersChange = (peers: readonly RoomPeer[]): void => {
    if (!connected) return;
    const selfPeerId = connected.peerId;
    const previousPeerIds = knownPeerIds;
    knownPeerIds = new Set(peers.map((peer) => peer.peerId));
    roomPeers = peers;
    presence.pruneToPeers(knownPeerIds);

    // A member still waiting for its own baseline has nothing to hand out.
    if (joinBaseline.hasBarrier()) return;

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
    if (responder?.peerId === selfPeerId) publisher.sendFullScene();
  };

  const subscriber: TransportSubscriber = {
    onConnectionStateChange: handleConnectionStateChange,
    onMessage: (message, meta) =>
      remoteApplier.handleRemoteMessage(message, meta),
    onRoomPeersChange: handleRoomPeersChange,
    // The transport dropped inbound scene traffic, so this side may be behind
    // with no sequence gap to detect. Our snapshot draws the sender's
    // `scene-init` reply (see `remote-apply.ts`), which carries whatever we
    // lost — the same repair path a detected gap uses.
    onSceneSyncRequired: () => publisher.sendFullScene(),
    // Frames arrived and none of them ever opened, which is the same verdict the
    // durable snapshot gives when it will not open — so it takes the same
    // terminal reason. This is the detector for the room the snapshot oracle
    // cannot cover: one with nothing stored yet, where the session would
    // otherwise stay connected, blank and silent forever.
    onRoomUnreadable: () => {
      if (context.isStopped()) return;
      lifecycle.failRecovery("unreadable-room");
    },
  };
  unsubscribeTransport = transport.subscribe(subscriber);

  return {
    connect() {
      if (destroyed) throw new Error("Collaboration session is destroyed");
      // Idempotent while an attempt or a live session exists: `connect()` arms
      // recovery, and recovery owns every attempt after the first.
      if (recovery.state().phase !== "idle") return;
      lifecycle.beginAttempt();
    },
    disconnect() {
      // Recovery is disarmed *before* the socket goes away, so the disconnect it
      // is about to observe reads as "the caller asked" rather than as a failure
      // worth retrying.
      lifecycle.abandonInFlightAttempt();
      offlineQueue.clear();
      recovery.stop();
      lifecycle.notifyRecovery();
      transport.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      publisher.cancelPendingFlush();
      presence.cancelPendingApply();
      joinBaseline.dispose();
      cadence.stop();
      repair.clear();
      // Abandons an in-flight token refresh, so a session torn down mid-attempt
      // cannot open a socket afterwards.
      lifecycle.abandonInFlightAttempt();
      offlineQueue.clear();
      recovery.stop();
      // Unsubscribed *before* the disconnect, as in the terminal teardown, so
      // the drop is not observed as a failure. No-op on a transport the caller
      // already closed.
      unsubscribeTransport?.();
      unsubscribeTransport = undefined;
      transport.disconnect();
    },
    handleLocalSceneChange(_elements, appState) {
      if (context.isStopped()) return;
      // A real edit means this client has something new to say, so the repair
      // budget is not being spent on a silent room.
      repair.noteRoomActivity();
      presence.setSelection(appState.selectedElementIds);
      // The flush reads the live scene from the API at send time, so
      // coalesced onChange bursts serialize the scene at most once per frame.
      publisher.scheduleFlush();
    },
    applyRemoteAssets(files) {
      bridge.applyRemoteAssets(files);
    },
    applyUnavailableAssets(fileIds) {
      bridge.applyUnavailableAssets(fileIds);
    },
    republishLocalAssets() {
      if (context.isStopped()) return;
      bridge.publishLocalAssets({ force: true });
    },
    handlePointerUpdate(payload) {
      if (context.isStopped()) return;
      presence.handlePointerUpdate(payload);
    },
    handleViewportChange(bounds, zoom) {
      if (context.isStopped()) return;
      presence.handleViewportChange({ bounds, zoom });
    },
    handleUserFollow(targetPeerId) {
      if (context.isStopped()) return;
      presence.handleUserFollow(targetPeerId);
    },
    setIdleState(nextIdleState) {
      if (context.isStopped()) return;
      presence.setIdleState(nextIdleState);
    },
    flushSnapshot() {
      return cadence.writeSnapshot({ force: true });
    },
    getConnectionState() {
      return transport.getConnectionState();
    },
    getRecoveryState() {
      return recovery.state();
    },
  };
}
