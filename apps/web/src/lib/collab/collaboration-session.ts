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
import {
  createOfflineChangeQueue,
  type OfflineChangeQueueOptions,
} from "@drawstuff/collaboration/offline-queue";
import {
  createRecoveryMachine,
  type RecoveryPolicyOptions,
  type RecoveryState,
  type UnrecoverableReason,
} from "@drawstuff/collaboration/recovery";
import { roomRoleCanEditScene } from "@drawstuff/collaboration/room-auth";
import {
  collaborationSnapshotDigest,
  electSnapshotWriter,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";
import type {
  CollaborationTransport,
  ConnectionState,
  DisconnectReason,
  RoomPeer,
  SendError,
  TransportSubscriber,
} from "@drawstuff/collaboration/transport";
import {
  EXCALIDRAW_CAPTURE_UPDATE_ACTION,
  EXCALIDRAW_USER_IDLE_STATE,
} from "@drawstuff/excalidraw-adapter/client";
import {
  collectReferencedFileIds,
  filterReferencedFiles,
} from "@drawstuff/excalidraw-adapter/codec";
import {
  createChangedElementTracker,
  getSyncableElements,
  markImageElementsUnavailable,
  reconcileRemoteElements,
  type ReconciliationLocalState,
} from "@drawstuff/excalidraw-adapter/reconcile";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawElement,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
  SceneData,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import type { CollaborationAssetStore } from "@/lib/collab/asset-store";
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

/**
 * Consecutive scene repairs a session will attempt with no sign of room activity
 * in between (see `armSceneRepair`).
 *
 * Small on purpose. One repair already covers a single dropped message, which is
 * the realistic case; the extra attempts cover a repair that is itself dropped.
 * Past this the room is treated as quiet and the session stops publishing, because
 * the alternative is a permanent full-scene heartbeat from every member.
 */
export const MAX_SCENE_REPAIR_ATTEMPTS = 3;

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

/** How far past a locked size contract the scene is, on one publish path. */
export type SceneSizeOverflow = {
  readonly byteLength: number;
  readonly maxByteLength: number;
};

/**
 * A publish path has stopped carrying this client's scene because the scene
 * exceeds the size contract that path is bound by.
 *
 * Reported rather than swallowed, because the failure is otherwise invisible and
 * does not heal on its own: nothing is marked sent, so the tracker keeps the same
 * pending set and the next `onChange` produces the identical refusal, while the
 * socket stays open and the session keeps looking connected. That is the one
 * shape of failure a user cannot discover — a canvas that quietly stops syncing
 * while the UI still says it is collaborating.
 *
 * The two paths are tracked separately because they fail independently and mean
 * different things: `realtime` is what the other members are no longer receiving,
 * `durable` is what a reload or a later joiner will no longer see. Neither is
 * terminal — both clear as soon as a send or a write is accepted, so removing
 * content restores sync without a reconnect.
 *
 * The size contracts themselves are Plan 12/15 decisions and are not relaxed
 * here: this is what the client does once one of them is hit.
 */
export type SceneSyncBlock = {
  readonly realtime: SceneSizeOverflow | null;
  readonly durable: SceneSizeOverflow | null;
};

/**
 * What the join established about the room's own state, which is what decides
 * how much of the local canvas may be published once the barrier opens.
 *
 * Separate from `BaselineOutcome` because the outcomes group differently for this
 * question than for the user-facing one: a peer snapshot and an empty room are
 * both "known", and a failed fetch and an expired deadline are both "unknown".
 */
/**
 * What a publish attempt did. `nothing-to-send` is not a failure: it is the room
 * already having everything this client holds, which is the normal steady state.
 */
type PublishOutcome = "sent" | "nothing-to-send" | "failed";

type BaselineKnowledge =
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
  /**
   * The engine's binary file store. It is the session's cache of decrypted
   * assets — the asset store keeps ids only — so "which images do I still need"
   * and "which images can I publish" are both answered from here.
   */
  getFiles(): BinaryFiles;
  addFiles(files: BinaryFileData[]): void;
};

/**
 * Credentials for one connection attempt.
 *
 * `authGeneration` travels with the token because it is what binds the token to
 * the key this session derived. If the owner rotates the generation while a
 * session is running, the next token comes back on the new generation — and the
 * session must stop rather than reconnect, because its derived key can no longer
 * open the room's ciphertext.
 */
export type JoinCredentials = {
  token: string;
  authGeneration: number;
};

/**
 * Why the backend would not issue credentials, and what recovery does about it.
 *
 * The classification is the caller's, not this module's: the backend's own error
 * vocabulary (an HTTP status, a tRPC code) is what distinguishes "you are no
 * longer in this room" from "the request did not get through", and the session
 * must not have to interpret transport errors to tell those apart. Getting the
 * split wrong in either direction is a real failure — retrying a revocation hides
 * it, and stopping on a blip abandons a session that was coming back.
 *
 * This is the authoritative split, not the relay's close code. The relay closes a
 * socket the moment the app withdraws its authorization, and it uses the same
 * code whether the member was removed or merely had their role changed — a role
 * change *requires* a reconnect, because the role travels in the token. Only the
 * next token request can distinguish them, so the terminal reasons live here.
 */
export type JoinCredentialsRefusal =
  /** Transport or backend failure of unknown cause; retried with backoff. */
  | { retry: true }
  /** Terminal, with the reason to report. */
  | {
      retry: false;
      failure: Extract<
        UnrecoverableReason,
        "unauthorized" | "membership-revoked" | "room-ended"
      >;
    };

export type JoinCredentialsResult =
  ({ ok: true } & JoinCredentials) | ({ ok: false } & JoinCredentialsRefusal);

export type CollaborationSessionOptions = {
  transport: CollaborationTransport;
  roomId: RoomId;
  clientId: ClientId;
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
  /**
   * Mints credentials for a reconnect attempt. Join tokens are short-lived by
   * design, so the token that opened the first socket is usually expired by the
   * time a reconnect happens — and re-asking the backend is also what makes a
   * revoked member's reconnect fail where it should, at authorization time.
   */
  refreshJoinToken: () => Promise<JoinCredentialsResult>;
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
    clientId,
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

  type ConnectedState = Extract<ConnectionState, { status: "connected" }>;

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
  const tracker = createChangedElementTracker();

  const recovery = createRecoveryMachine(options.recovery);
  /**
   * Bounded accounting of what changed while the session was down, and the only
   * thing that decides whether a reconnect can be a delta.
   */
  const offlineQueue = createOfflineChangeQueue(options.offlineQueue);
  /** Credentials for the current attempt; replaced by every refresh. */
  let credentials: JoinCredentials = { token: joinToken, authGeneration };
  let cancelReconnectTimer: (() => void) | undefined;
  /** Full-sync repair armed after the last publish; see `armSceneRepair`. */
  let cancelSceneRepair: (() => void) | undefined;
  /** Consecutive timer-driven repairs with no room activity in between. */
  let sceneRepairAttempts = 0;
  /**
   * Invalidates an in-flight token refresh. A refresh that settles after the
   * caller disconnected — or after a later attempt superseded it — must not open
   * a socket nobody asked for.
   */
  let attemptEpoch = 0;
  /**
   * False until the first baseline resolves. A first join publishes the whole
   * canvas; only a *re*join has a room state to diff against.
   */
  let hasSynced = false;

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

  /**
   * Size-blocked publish paths; see `SceneSyncBlock`. Held as two independent
   * slots rather than one flag because a scene can breach the realtime contract
   * (1 MiB per message) and the durable one (4 MiB per snapshot) separately, and
   * the two clear on different events.
   */
  let realtimeOverflow: SceneSizeOverflow | undefined;
  let durableOverflow: SceneSizeOverflow | undefined;
  const notifyRecovery = (): void => {
    onRecoveryStateChange?.(recovery.state());
  };

  /**
   * Reports the current set of blocked paths, and `null` once none are blocked.
   *
   * Only ever called on a *transition*, which is why the observed byte counts are
   * latched by the setters below rather than refreshed. A blocked realtime path
   * re-fails on every single flush, and each attempt measures a few bytes
   * differently — a new `messageId`, a bumped sequence, a moved element — so
   * reporting each measurement would push a fresh object at the caller once per
   * animation frame for a condition that has not changed. The first measurement is
   * the one worth keeping: it is the size at which sync stopped, and the number
   * exists to give the user a sense of scale, not to track the canvas.
   */
  const notifySceneSyncBlock = (): void => {
    onSceneSyncBlockChange?.(
      realtimeOverflow || durableOverflow
        ? {
            realtime: realtimeOverflow ?? null,
            durable: durableOverflow ?? null,
          }
        : null,
    );
  };

  /** Latches the realtime block; a repeat of an already-reported block is a no-op. */
  const noteSceneSendRefusedAsOversize = (
    overflow: SceneSizeOverflow,
  ): void => {
    if (realtimeOverflow) return;
    realtimeOverflow = overflow;
    notifySceneSyncBlock();
  };

  /** A scene message the transport accepted: the realtime path carries us again. */
  const noteSceneSendAccepted = (): void => {
    if (!realtimeOverflow) return;
    realtimeOverflow = undefined;
    notifySceneSyncBlock();
  };

  const noteSnapshotRefusedAsOversize = (overflow: SceneSizeOverflow): void => {
    if (durableOverflow) return;
    durableOverflow = overflow;
    notifySceneSyncBlock();
  };

  const noteSnapshotWritten = (): void => {
    if (!durableOverflow) return;
    durableOverflow = undefined;
    notifySceneSyncBlock();
  };

  const clearReconnectTimer = (): void => {
    cancelReconnectTimer?.();
    cancelReconnectTimer = undefined;
  };

  /** Opens a socket with the credentials already in hand. */
  const beginAttempt = (): void => {
    recovery.start();
    notifyRecovery();
    transport.connect({ roomId, clientId, joinToken: credentials.token });
  };

  /**
   * The single terminal teardown. Every path that ends recovery goes through it,
   * whether the reason came from the transport, from the backend, or from this
   * session's own state.
   *
   * Being terminal is not just a label on the state machine: the session stops
   * doing work. It drops the connection (a socket held open in this condition
   * looks connected while syncing nothing), abandons any token refresh still in
   * flight, cancels the pending flush and the retry timer, releases its transport
   * subscription, and empties the offline queue. `terminated` is what keeps the
   * editor's own callbacks from refilling any of that — the caller still holds a
   * live session object and will keep sending `onChange` until it tears it down.
   */
  const terminate = (): void => {
    terminated = true;
    clearReconnectTimer();
    // Abandons any token refresh still in flight for this session.
    attemptEpoch += 1;
    // And any snapshot load or write still in flight. Those are guarded by
    // `joinEpoch`, not by `attemptEpoch`, so without this a durable load issued
    // during the join could still resolve afterwards and write the room's elements
    // onto the canvas of a session that has already stopped.
    joinEpoch += 1;
    cancelPendingFlush?.();
    cancelPendingFlush = undefined;
    clearSceneRepair();
    offlineQueue.clear();
    transport.disconnect();
    unsubscribeTransport?.();
    unsubscribeTransport = undefined;
  };

  const failRecovery = (reason: UnrecoverableReason): void => {
    recovery.fail(reason);
    terminate();
    notifyRecovery();
  };

  /**
   * Applies the recovery policy to a lost connection: schedule the next attempt,
   * stop with a stated reason, or ignore it because we asked for it.
   */
  const handleConnectionLoss = (reason: DisconnectReason): void => {
    const next = recovery.lost(reason);
    if (next.phase === "failed") {
      // A terminal reason reported by the transport takes the same teardown as
      // any other, rather than only flipping the state machine and leaving the
      // session's timers, queue and subscription running.
      terminate();
      notifyRecovery();
      return;
    }
    notifyRecovery();
    if (next.phase !== "waiting") return;
    clearReconnectTimer();
    cancelReconnectTimer = scheduleTimeout(() => {
      cancelReconnectTimer = undefined;
      if (destroyed || terminated) return;
      reconnect();
    }, next.delayMs);
  };

  /**
   * Mints fresh credentials and reconnects.
   *
   * The token is refreshed rather than reused because join tokens are
   * short-lived, and because re-asking the backend is what makes a reconnect fail
   * where it should: a member removed while offline is refused here, not left
   * looping against the relay.
   */
  const reconnect = (): void => {
    const epoch = (attemptEpoch += 1);
    recovery.start();
    notifyRecovery();
    void (async () => {
      let refreshed: JoinCredentialsResult;
      try {
        refreshed = await refreshJoinToken();
      } catch {
        // An unexpected throw is not evidence of lost access — a fetch that
        // never left the machine looks exactly like this — so it is retried.
        refreshed = { ok: false, retry: true };
      }
      if (destroyed || epoch !== attemptEpoch) return;
      if (!refreshed.ok) {
        // The backend is the authority on whether this client may still be in the
        // room, so its refusal is what ends recovery — including for a member the
        // relay closed as "revoked", which is also how a role change arrives.
        if (!refreshed.retry) {
          failRecovery(refreshed.failure);
          return;
        }
        handleConnectionLoss("transient");
        return;
      }
      // The room's generation moved under us, so this session's derived keys can
      // no longer open the room. Reconnecting would produce a client that is
      // connected and permanently blind; a new link is the only fix.
      if (refreshed.authGeneration !== authGeneration) {
        failRecovery("generation-rotated");
        return;
      }
      credentials = {
        token: refreshed.token,
        authGeneration: refreshed.authGeneration,
      };
      transport.connect({ roomId, clientId, joinToken: credentials.token });
    })();
  };

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
   * per-message contract (Plan 12), which the relay enforces too, so no amount of
   * retrying will get it through — but the session is otherwise healthy, and the
   * fix is a local edit away. Keeping the connection and announcing that outbound
   * sync has stopped is therefore the honest state; terminating would throw away
   * a session the user can still recover, and staying quiet is the silent-stop
   * this branch exists to remove.
   */
  const handleSceneSendError = (error: SendError): void => {
    if (error.code === "crypto-exhausted") {
      failRecovery("crypto-exhausted");
      return;
    }
    if (error.code === "oversize-payload") {
      noteSceneSendRefusedAsOversize({
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
    if (barrier || !connected || !canEditScene()) return;
    publishLocalAssets();
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
    const result = transport.sendSceneMessage(message);
    if (result.ok) {
      sceneSequence += 1;
      batch.markSent();
      noteSceneSendAccepted();
      lastFullSceneSyncAt = currentNow;
      // Armed even though this published everything: this very snapshot can be
      // the message that gets dropped, and then nothing else would retry it. An
      // empty scene is exempt — there is no state a drop could lose.
      if (batch.elements.length > 0) armSceneRepair();
      return;
    }
    handleSceneSendError(result.error);
  };

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
  const sendSceneDelta = (): PublishOutcome => {
    if (barrier || !connected || !canEditScene()) return "failed";
    const currentNow = now();
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
      noteSceneSendAccepted();
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
    const currentNow = now();
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
    if (!canSyncScene()) return;
    // Disconnected: account for the change, bounded, so the reconnect can decide
    // between replaying a delta and falling back to one full sync.
    if (!connected) {
      recordOfflineChanges();
      return;
    }
    // Local edits made during the join window are not lost either: the tracker
    // still holds them, and the rejoin publish that follows the baseline carries
    // them.
    if (barrier || !canEditScene()) return;
    publishLocalAssets();
    const currentNow = now();
    // Throttled full resync (upstream SYNC_FULL_SCENE_INTERVAL_MS): a
    // snapshot supersedes the delta and heals any receiver-side gaps.
    if (currentNow - lastFullSceneSyncAt >= fullSceneSyncIntervalMs) {
      sendFullScene();
      return;
    }
    // Armed only when something actually went on the wire: a repair exists to
    // re-send state that may have been dropped, and a send that carried nothing
    // has nothing to lose.
    if (sendSceneDelta() === "sent") armSceneRepair();
  };

  /**
   * Arms the repair that heals a publish nobody received.
   *
   * Every other repair path in the session is reactive: a sequence gap is noticed
   * when a *later* message from that sender arrives, a received snapshot draws a
   * reply, a newcomer draws a snapshot. All of them need traffic to happen next —
   * and the one case with no traffic next is the one that matters most. If the last
   * message of the room's activity is dropped and the room then goes quiet, the
   * sender has no acknowledgement to miss and the receiver sees no gap, so the
   * divergence is permanent.
   *
   * The throttled full resync was already meant to be that backstop, but it only
   * ran when a flush happened to occur, and an idle room never flushes. This puts
   * it on a timer, armed after *any* successful publish — a snapshot can be dropped
   * just as easily as a delta, so arming only after deltas would leave the same
   * hole one step further along.
   *
   * `maxSceneRepairAttempts` is what keeps that from becoming a permanent
   * heartbeat. The counter measures consecutive repairs with no sign of life in
   * between: a local edit or any inbound scene message resets it, because either
   * one means the reactive paths are working again. A room that goes completely
   * silent therefore emits a small bounded number of repairs and stops.
   */
  function armSceneRepair(): void {
    if (sceneRepairAttempts >= maxSceneRepairAttempts) return;
    cancelSceneRepair?.();
    cancelSceneRepair = scheduleTimeout(() => {
      cancelSceneRepair = undefined;
      if (isStopped()) return;
      sceneRepairAttempts += 1;
      scheduleFlush();
    }, fullSceneSyncIntervalMs);
  }

  /** Any sign that the room is still exchanging traffic re-earns the budget. */
  const noteRoomActivity = (): void => {
    sceneRepairAttempts = 0;
  };

  const clearSceneRepair = (): void => {
    cancelSceneRepair?.();
    cancelSceneRepair = undefined;
  };

  /**
   * True once this session will never do useful work again — torn down by the
   * caller, or stopped by a terminal recovery failure. The editor keeps calling in
   * either case, so the entry points that would otherwise walk the scene, measure
   * elements or build messages check this first.
   */
  const isStopped = (): boolean => destroyed || terminated;

  const scheduleFlush = (): void => {
    if (isStopped() || cancelPendingFlush) return;
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
    const result = transport.sendPresenceMessage(message);
    if (result.ok) {
      presenceSequence += 1;
      lastPresenceSentAt = now();
      return;
    }
    // Presence loss is free — the next pointer sample repairs it — with one
    // exception: a spent nonce budget is terminal for the whole session, and
    // presence is the channel most likely to reach it first.
    if (result.error.code === "crypto-exhausted") {
      failRecovery("crypto-exhausted");
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
    requestMissingAssets(elements);
  };

  /**
   * Asks the asset store for the images the elements just applied reference and
   * the canvas does not have.
   *
   * Driven by the *incoming* elements rather than by the whole scene, which is
   * what keeps a delta cheap: a pointer-drag of an existing image references an
   * id the canvas already holds and produces no request at all. A join baseline
   * happens to be the whole scene, so the same call covers the late-joiner and
   * page-refresh cases.
   *
   * Fire-and-forget on purpose. A missing or unopenable asset must never hold up
   * element sync — the scene converges and the image either arrives later or does
   * not.
   */
  function requestMissingAssets(elements: readonly SyncedElement[]): void {
    if (!assetStore || destroyed || !canSyncScene()) return;
    const files = sceneApi.getFiles();
    const missing = collectReferencedFileIds(elements).filter(
      (fileId) => !files[fileId],
    );
    if (missing.length === 0) return;
    void assetStore.request(missing);
  }

  /**
   * Publishes the images the local canvas holds and the room does not.
   *
   * Runs on the same coalesced flush as the outbound deltas, because that is when
   * a newly added image is first broadcast: peers receive the element and the
   * ciphertext lands moments later. The store decides what is actually new, so
   * calling this repeatedly is how a failed upload is retried — and a scene with
   * no files at all never walks its elements.
   */
  const publishLocalAssets = (): void => {
    if (!assetStore || !canEditScene()) return;
    const files = sceneApi.getFiles();
    if (Object.keys(files).length === 0) return;
    const referenced = filterReferencedFiles(
      sceneApi.getSceneElementsIncludingDeleted(),
      files,
    );
    const pending = Object.values(referenced);
    if (pending.length > 0) void assetStore.publish(pending);
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
    // Inbound scene traffic means the reactive repair paths are working, so the
    // timer-driven budget is restored.
    noteRoomActivity();
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
    if (!connected || !canEditScene()) return;
    publishLocalAssets();
    const verdict = offlineQueue.drain(now());
    if (
      !params.rejoin ||
      params.knowledge === "unknown" ||
      verdict.mode === "full-sync"
    ) {
      sendFullScene();
      return;
    }
    // Both `delta` and `none` take this path: "nothing changed while offline"
    // still leaves the possibility that the last frame before the socket broke
    // never landed, and the pending set covers exactly that.
    //
    // The backstop is only rearmed when the delta actually went out. A refused
    // send leaves it where it was, so the retried flush publishes a full snapshot
    // instead of quietly waiting out the interval with unsent state.
    const published = sendSceneDelta();
    if (published === "failed") return;
    // The reconnect exchange reconciled this client with the room, so the periodic
    // backstop restarts from here rather than firing on the very next edit.
    lastFullSceneSyncAt = now();
    if (published === "sent") armSceneRepair();
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
      applyRemoteElements(message.payload.elements);
    }
    const rejoin = hasSynced;
    hasSynced = true;
    if (recovery.state().phase === "syncing") {
      // Only a resolved baseline counts as progress, so this is also what clears
      // the retry budget: a relay that accepts joins and drops them keeps backing
      // off instead of hammering at the base delay.
      recovery.synced();
      notifyRecovery();
    }
    onBaselineResolved?.(outcome);
    // Also the repair for a buffer that overflowed: what we publish draws the
    // peers' snapshot replies, which carry whatever the drop lost.
    publishAfterBaseline({ rejoin, knowledge });
    // A viewer cannot publish, so the line above is not a repair for it. Re-read
    // the durable baseline instead, which recovers everything up to the last
    // stored snapshot without needing a frame the relay would refuse. Edits newer
    // than that snapshot still arrive with a peer's periodic full sync.
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
      if (barrier?.claimBaseline()) releaseBarrier("durable-snapshot", "known");
      return;
    }
    if (result.status === "empty") {
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = true;
      // An empty room is a baseline: "the room has nothing" is knowledge, and it
      // is what makes a first publish of the local canvas correct.
      if (barrier?.claimBaseline()) releaseBarrier("empty", "known");
      return;
    }
    // The baseline stays unknown, and `writeSnapshot` refuses while it is:
    // replacing a snapshot we could not read would destroy room history on the
    // strength of a canvas we have no reason to believe is complete.
    snapshotBaselineKnown = false;
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
    if (unreadable) failRecovery("unreadable-room");
  };

  const openBarrier = (epoch: number): void => {
    barrier = createJoinBarrier(options.joinBarrier);
    // Backstop for a store that never answers at all: the barrier must not hold
    // inbound traffic — or the canvas — indefinitely.
    cancelBaselineTimeout = scheduleTimeout(() => {
      cancelBaselineTimeout = undefined;
      if (epoch !== joinEpoch || !barrier?.claimBaseline()) return;
      // No room state was obtained, so there is nothing to diff against and the
      // whole canvas goes out.
      releaseBarrier("snapshot-unavailable", "unknown");
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
    if (digest === lastSnapshotDigest && !force) {
      // Nothing to write — and that also means durability is *intact*, because
      // `lastSnapshotDigest` is only ever set by a write that landed. This has to
      // clear a latched block explicitly: an oversize edit that was subsequently
      // undone leaves the canvas byte-identical to the stored baseline, so the
      // write that would have cleared the block is exactly the write this return
      // skips, and the room would stay marked as un-backed-up for good.
      noteSnapshotWritten();
      return;
    }

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
        noteSnapshotWritten();
        return;
      }
      // The scene is past the locked snapshot contract (Plan 15), so every
      // remaining tick — and the leave flush that is the room's last chance to
      // persist anything — will be refused for the same reason. Unlike a failed
      // request this is not something waiting fixes, so it is surfaced instead of
      // being dropped along with the other non-conflict outcomes below.
      if (result.status === "oversize") {
        noteSnapshotRefusedAsOversize({
          byteLength: result.byteLength,
          maxByteLength: result.maxByteLength,
        });
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
        noteSnapshotWritten();
        return;
      }
      // Merging the winner can push a scene that fit on its own past the limit,
      // and this is the last write the room will get — so the refusal is reported
      // here too rather than only on the cadence path.
      if (retried.status === "oversize") {
        noteSnapshotRefusedAsOversize({
          byteLength: retried.byteLength,
          maxByteLength: retried.maxByteLength,
        });
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
        releaseBarrier("peer", "known");
        return;
      }
      barrier.hold(message, meta.byteLength);
      return;
    }

    deliverSceneMessage(message, verdict.sceneSyncRequired);
  };

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
        notifyRecovery();
      }
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
      roomPeers = [
        { peerId: state.peerId, clientId: state.clientId, role: state.role },
      ];
      snapshotRevision = SNAPSHOT_NO_REVISION;
      snapshotBaselineKnown = false;
      lastSnapshotDigest = undefined;
      noteRoomActivity();
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
    // Nothing to repair while there is no session: the offline queue takes over,
    // and the rejoin publish is what brings the room up to date.
    clearSceneRepair();
    if (collaborators.size > 0) {
      collaborators.clear();
      applyCollaborators();
    }
    if (state.status === "disconnected") {
      handleConnectionLoss(state.reason);
      return;
    }
    // The transport is closed for good, so there is nothing left to recover.
    clearReconnectTimer();
    recovery.stop();
    notifyRecovery();
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
    // Frames arrived and none of them ever opened, which is the same verdict the
    // durable snapshot gives when it will not open — so it takes the same
    // terminal reason. This is the detector for the room the snapshot oracle
    // cannot cover: one with nothing stored yet, where the session would
    // otherwise stay connected, blank and silent forever.
    onRoomUnreadable: () => {
      if (isStopped()) return;
      failRecovery("unreadable-room");
    },
  };
  unsubscribeTransport = transport.subscribe(subscriber);

  return {
    connect() {
      if (destroyed) throw new Error("Collaboration session is destroyed");
      // Idempotent while an attempt or a live session exists: `connect()` arms
      // recovery, and recovery owns every attempt after the first.
      if (recovery.state().phase !== "idle") return;
      beginAttempt();
    },
    disconnect() {
      // Recovery is disarmed *before* the socket goes away, so the disconnect it
      // is about to observe reads as "the caller asked" rather than as a failure
      // worth retrying.
      clearReconnectTimer();
      attemptEpoch += 1;
      offlineQueue.clear();
      recovery.stop();
      notifyRecovery();
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
      clearReconnectTimer();
      clearSceneRepair();
      // Abandons an in-flight token refresh, so a session torn down mid-attempt
      // cannot open a socket afterwards.
      attemptEpoch += 1;
      offlineQueue.clear();
      recovery.stop();
      unsubscribeTransport?.();
      unsubscribeTransport = undefined;
    },
    handleLocalSceneChange(_elements, appState) {
      if (isStopped()) return;
      // A real edit means this client has something new to say, so the repair
      // budget is not being spent on a silent room.
      noteRoomActivity();
      lastSelectedElementIds = Object.keys(appState.selectedElementIds)
        .filter((id) => id.length <= MAX_PRESENCE_ELEMENT_ID_LENGTH)
        .slice(0, MAX_PRESENCE_SELECTED_ELEMENT_IDS);
      // The flush reads the live scene from the API at send time, so
      // coalesced onChange bursts serialize the scene at most once per frame.
      scheduleFlush();
    },
    applyRemoteAssets(files) {
      // Same guards as any other remote write: a canvas that no longer belongs to
      // the room must not gain the room's images, and the write must not mark the
      // scene dirty.
      if (destroyed || files.length === 0 || !canSyncScene()) return;
      wrapRemoteApply(() => {
        sceneApi.addFiles([...files]);
      });
    },
    applyUnavailableAssets(fileIds) {
      if (destroyed || fileIds.length === 0 || !canSyncScene()) return;
      wrapRemoteApply(() => {
        const marked = markImageElementsUnavailable(
          sceneApi.getSceneElementsIncludingDeleted(),
          new Set(fileIds),
        );
        // Nothing on this canvas referenced those ids — the element may have been
        // deleted while its download was still running.
        if (!marked) return;
        sceneApi.updateScene({
          elements: marked,
          captureUpdate: EXCALIDRAW_CAPTURE_UPDATE_ACTION.NEVER,
        });
      });
    },
    republishLocalAssets() {
      if (isStopped()) return;
      publishLocalAssets();
    },
    handlePointerUpdate(payload) {
      if (isStopped()) return;
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
      if (isStopped() || idleState === nextIdleState) return;
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
    getRecoveryState() {
      return recovery.state();
    },
  };
}
