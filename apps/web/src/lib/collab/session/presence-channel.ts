import type {
  PeerId,
  PresenceMessage,
} from "@drawstuff/collaboration/protocol";
import type {
  CollaborationTransport,
  SendError,
} from "@drawstuff/collaboration/transport";
import type { UnrecoverableReason } from "@drawstuff/collaboration/recovery";
import { EXCALIDRAW_USER_IDLE_STATE } from "@drawstuff/excalidraw-adapter/client";
import type {
  AppState,
  Collaborator,
  ExcalidrawPointerUpdatePayload,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import {
  shouldReleaseFollow,
  type FollowEdge,
} from "@/lib/collab/session/follow-mode";
import type {
  BuildEnvelope,
  SessionContext,
} from "@/lib/collab/session/session-context";

const MAX_PRESENCE_SELECTED_ELEMENT_IDS = 256;
const MAX_PRESENCE_ELEMENT_ID_LENGTH = 64;

/**
 * How often a client re-announces its follow state while it has one, plus the
 * single confirmation it sends after a release. Presence is volatile — the
 * relay may drop it under backpressure — and every ordinary sample already
 * carries the full follow state, so this only papers over the one gap left:
 * an *idle* client whose transition frame was lost and who would otherwise
 * stay silent indefinitely.
 */
const FOLLOW_STATE_RESEND_MS = 2_000;

type PresencePayload = PresenceMessage["payload"];
export type CollaborationIdleState = PresencePayload["idleState"];
export type PresenceViewBounds = NonNullable<PresencePayload["viewBounds"]>;

/**
 * The engine-facing half of follow mode, provided by the host. The engine
 * owns the follow *UI* (avatar click, purple frame, `appState.userToFollow`);
 * these callbacks are how the session moves the local viewport and keeps the
 * engine's follow state truthful. All three are invoked inside
 * `wrapPresenceApply`: they carry no scene state.
 */
export type FollowHost = {
  /** Fit the local viewport to the followed peer's visible scene bounds. */
  applyViewportBounds(bounds: PresenceViewBounds): void;
  /** Clear the engine's follow target (`appState.userToFollow`), used when
   *  the session releases a follow the user did not end themselves — a cycle
   *  break or the followed peer leaving. */
  clearFollowTarget(): void;
  /** Peers currently following this client (`appState.followedBy`). */
  applyFollowedBy(peerIds: readonly PeerId[]): void;
};

const USER_IDLE_STATE_BY_PRESENCE = {
  active: EXCALIDRAW_USER_IDLE_STATE.ACTIVE,
  idle: EXCALIDRAW_USER_IDLE_STATE.IDLE,
  away: EXCALIDRAW_USER_IDLE_STATE.AWAY,
} as const;

export type PresenceChannel = {
  /** Wire to the editor `onPointerUpdate`: sends bounded-throttle presence. */
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
  /**
   * Wire to the editor `onScrollChange`: shares the local visible scene
   * bounds under the same throttle, with a trailing send so the *final*
   * viewport of a scroll always reaches followers (a dropped pointer sample
   * is repaired by the next pointer event; a dropped final scroll is not).
   */
  handleViewportChange(bounds: PresenceViewBounds): void;
  /**
   * Wire to the editor `onUserFollow`: the engine set (or cleared) its follow
   * target and the session mirrors it into presence. Starting a follow snaps
   * the viewport to the target's last known bounds immediately.
   */
  handleUserFollow(targetPeerId: PeerId | null): void;
  setIdleState(idleState: CollaborationIdleState): void;
  /** The engine's selection record, held by reference; see the field doc. */
  setSelection(selectedElementIds: AppState["selectedElementIds"]): void;
  /** A gate-accepted presence message from a current member. */
  receivePresence(message: PresenceMessage): void;
  /** Drops departed members' cursors and pushes the pruned map if any left. */
  pruneToPeers(knownPeerIds: ReadonlySet<string>): void;
  /** Clears every cursor (pushing the empty map if any were shown). */
  clear(): void;
  /** Cancels a coalesced apply without touching the map; for `destroy()`. */
  cancelPendingApply(): void;
  /** New socket: sequences restart and the throttle window reopens. */
  resetForConnection(): void;
};

/**
 * Everything presence: the outbound throttled channel and the inbound
 * collaborator map, which is presence's canvas footprint.
 *
 * A reconnect is a new peer, so its cursor is rebuilt rather than carried
 * over — the same behaviour as upstream's socket-keyed collaborators.
 */
export const createPresenceChannel = (options: {
  context: SessionContext;
  transport: Pick<CollaborationTransport, "sendPresenceMessage">;
  buildEnvelope: BuildEnvelope;
  /**
   * Display name carried in presence. Empty means unnamed: the channel falls
   * back to `guest-<peerId suffix>` per connection, because the peer id — the
   * only collaboration identity — is assigned by the relay and does not exist
   * until the join completes.
   */
  username: string;
  presenceThrottleMs: number;
  /**
   * Presence-only canvas writes (the collaborator map) run through this wrapper
   * instead of `wrapRemoteApply`. They carry no scene state, so a host whose
   * remote-apply wrapper defers its cleanup (dirty-tracking suppression released
   * a frame later) can pass a synchronous wrapper here.
   */
  wrapPresenceApply(apply: () => void): void;
  /** The session's coalescing scheduler (animation frame + backstop). */
  scheduleSceneFlush(flush: () => void): () => void;
  /** A spent nonce budget is terminal for the whole session. */
  failRecovery(reason: UnrecoverableReason): void;
  /** Absent means follow mode is inert: presence still carries viewport and
   *  follow state, but nothing moves the local viewport (headless tests). */
  follow?: FollowHost;
}): PresenceChannel => {
  const { context, transport, buildEnvelope, username, presenceThrottleMs } =
    options;

  let presenceSequence = 0;
  let lastPresenceSentAt = Number.NEGATIVE_INFINITY;
  let lastPointer: PresencePayload["pointer"] | undefined;
  let lastButton: PresencePayload["button"] = "up";
  /**
   * The engine's own selection record, held by reference. The bounded id array
   * is derived in `sendPresence` — throttled to ~30fps — instead of on every
   * `onChange`, which fires far more often and would allocate three arrays per
   * call for a value most calls never send.
   */
  let lastSelectedElementIds: AppState["selectedElementIds"] = {};
  let idleState: CollaborationIdleState = "active";
  /** Local visible scene bounds; survives reconnects — the viewport does. */
  let lastViewBounds: PresenceViewBounds | undefined;
  /** This client's follow edge, mirrored into every presence message. */
  let selfFollow: FollowEdge | undefined;
  /** Latest viewport per peer, so starting a follow can snap immediately. */
  const remoteViewBounds = new Map<PeerId, PresenceViewBounds>();
  /** Latest follow edge per peer — the graph the cycle rule runs on. */
  const remoteFollows = new Map<PeerId, FollowEdge>();
  /** Last `followedBy` set pushed to the engine, to skip no-op writes. */
  let appliedFollowedByKey = "";
  /** Present only while a trailing viewport send is scheduled. */
  let cancelTrailingSend: (() => void) | undefined;
  /** Present only while a follow-state resend is scheduled. */
  let cancelFollowResend: (() => void) | undefined;
  /**
   * Largest follow timestamp observed from any peer. New follows are stamped
   * past it (Lamport-style), so "the last actor wins" holds even when the
   * actors' wall clocks disagree: an edge created *after seeing* another edge
   * is always the newer one.
   */
  let latestObservedFollowSince = 0;

  /** Latest presence per collaborator peer; replaced wholesale on apply so
   *  the engine always receives a fresh Map. Bounded by room membership. */
  const collaborators = new Map<PeerId, Collaborator>();

  /** Present only while a coalesced collaborator apply is scheduled. */
  let cancelPendingCollaboratorApply: (() => void) | undefined;

  const applyCollaborators = (): void => {
    cancelPendingCollaboratorApply?.();
    cancelPendingCollaboratorApply = undefined;
    const next = new Map<SocketId, Collaborator>();
    for (const [collaboratorPeerId, collaborator] of collaborators) {
      next.set(collaboratorPeerId as unknown as SocketId, collaborator);
    }
    options.wrapPresenceApply(() => {
      context.sceneApi.updateScene({ collaborators: next });
    });
  };

  /**
   * Coalesces per-message presence into one engine push per frame. N peers at
   * ~30fps each otherwise rebuild the collaborator map and hit the engine N×30
   * times a second for cursors that paint once per frame anyway. Membership
   * prunes and teardown keep calling `applyCollaborators` directly — a departed
   * cursor must vanish now, not a frame later — and the direct call cancels the
   * pending one, so the coalesced apply never overwrites a newer prune.
   */
  const scheduleCollaboratorApply = (): void => {
    if (cancelPendingCollaboratorApply) return;
    cancelPendingCollaboratorApply = options.scheduleSceneFlush(() => {
      cancelPendingCollaboratorApply = undefined;
      if (context.isStopped()) return;
      applyCollaborators();
    });
  };

  const cancelTrailing = (): void => {
    cancelTrailingSend?.();
    cancelTrailingSend = undefined;
  };

  const sendPresence = (): void => {
    cancelTrailing();
    const connected = context.connected;
    if (!connected) return;
    const message: PresenceMessage = {
      ...buildEnvelope(connected, presenceSequence + 1),
      type: "presence",
      payload: {
        pointer: lastPointer,
        button: lastButton,
        username: username || `guest-${connected.peerId.slice(-4)}`,
        selectedElementIds: Object.keys(lastSelectedElementIds)
          .filter((id) => id.length <= MAX_PRESENCE_ELEMENT_ID_LENGTH)
          .slice(0, MAX_PRESENCE_SELECTED_ELEMENT_IDS),
        idleState,
        viewBounds: lastViewBounds,
        follow: selfFollow,
      },
    };
    const result = transport.sendPresenceMessage(message);
    if (result.ok) {
      presenceSequence += 1;
      lastPresenceSentAt = context.now();
      return;
    }
    // Presence loss is free — the next pointer sample repairs it — with one
    // exception: a spent nonce budget is terminal for the whole session, and
    // presence is the channel most likely to reach it first.
    if ((result.error as SendError).code === "crypto-exhausted") {
      options.failRecovery("crypto-exhausted");
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
      id: message.senderPeerId,
      socketId: message.senderPeerId as unknown as SocketId,
    };
  };

  /** Trailing edge for viewport sends: fires once the throttle window closes,
   *  so the final bounds of a scroll reach followers even with no event after
   *  it. Any earlier leading-edge send cancels it (it carries the bounds). */
  const queueTrailingSend = (): void => {
    if (cancelTrailingSend) return;
    const dueInMs = Math.max(
      0,
      presenceThrottleMs - (context.now() - lastPresenceSentAt),
    );
    cancelTrailingSend = context.scheduleTimeout(() => {
      cancelTrailingSend = undefined;
      if (context.isStopped()) return;
      sendPresence();
    }, dueInMs);
  };

  const applyViewport = (bounds: PresenceViewBounds): void => {
    const follow = options.follow;
    if (!follow) return;
    // Unlike cursor presence, the viewport is scene-adjacent state: once the
    // canvas no longer holds this room's scene, room traffic must not pan or
    // zoom whatever replaced it.
    if (!context.canSyncScene()) return;
    // No dedupe here: only the host can tell whether unchanged bounds still
    // fit — a local resize or a manual pan changes the answer — so the host's
    // apply is the idempotent step (it compares the fit against the live
    // viewport before writing).
    options.wrapPresenceApply(() => follow.applyViewportBounds(bounds));
  };

  /**
   * One resend of the current follow state after `FOLLOW_STATE_RESEND_MS`,
   * re-armed while a follow is active. Armed on every follow transition: a
   * release therefore gets exactly one confirmation, an active follow a slow
   * heartbeat.
   */
  const armFollowResend = (): void => {
    cancelFollowResend?.();
    cancelFollowResend = context.scheduleTimeout(() => {
      cancelFollowResend = undefined;
      if (context.isStopped() || !context.connected) return;
      sendPresence();
      if (selfFollow) armFollowResend();
    }, FOLLOW_STATE_RESEND_MS);
  };

  const cancelFollowResendTimer = (): void => {
    cancelFollowResend?.();
    cancelFollowResend = undefined;
  };

  /** Ends this client's follow from the session side (cycle break, departed
   *  target) and tells the engine, whose UNFOLLOW echo is a no-op here. */
  const releaseFollow = (): void => {
    if (!selfFollow) return;
    selfFollow = undefined;
    const follow = options.follow;
    // A canvas that already left the room has no follow state to clear.
    if (follow && context.canSyncScene()) {
      options.wrapPresenceApply(() => follow.clearFollowTarget());
    }
    sendPresence();
    armFollowResend();
  };

  const maybeReleaseFollowCycle = (): void => {
    const connected = context.connected;
    if (!connected || !selfFollow) return;
    const release = shouldReleaseFollow({
      selfPeerId: connected.peerId,
      selfFollow,
      peerFollows: remoteFollows,
    });
    if (release) releaseFollow();
  };

  const applyFollowedByIfChanged = (): void => {
    const connected = context.connected;
    const follow = options.follow;
    if (!connected || !follow || !context.canSyncScene()) return;
    const followers = [...remoteFollows.entries()]
      .filter(([, edge]) => edge.peerId === connected.peerId)
      .map(([followerPeerId]) => followerPeerId)
      .sort();
    const key = followers.join("\n");
    if (key === appliedFollowedByKey) return;
    appliedFollowedByKey = key;
    options.wrapPresenceApply(() => follow.applyFollowedBy(followers));
  };

  return {
    handlePointerUpdate(payload) {
      lastPointer = {
        x: payload.pointer.x,
        y: payload.pointer.y,
        tool: payload.pointer.tool,
      };
      lastButton = payload.button;
      // Leading-edge throttle without timers: presence is volatile, so a
      // dropped trailing sample is repaired by the next pointer event.
      if (context.now() - lastPresenceSentAt >= presenceThrottleMs) {
        sendPresence();
      }
    },
    handleViewportChange(bounds) {
      // Once the canvas stops holding this room's scene, its viewport is the
      // *replacement* scene's viewport: caching or publishing it would leak
      // where the user is looking in an unrelated scene.
      if (!context.canSyncScene()) return;
      lastViewBounds = bounds;
      if (context.now() - lastPresenceSentAt >= presenceThrottleMs) {
        sendPresence();
        return;
      }
      queueTrailingSend();
    },
    handleUserFollow(targetPeerId) {
      if (targetPeerId === (selfFollow?.peerId ?? null)) return;
      if (targetPeerId === null) {
        // The user ended the follow themselves; the engine already cleared
        // its own state, so only the presence mirror changes.
        selfFollow = undefined;
        sendPresence();
        armFollowResend();
        return;
      }
      selfFollow = {
        peerId: targetPeerId,
        // Stamped past every follow edge seen so far, so "created after
        // seeing yours" always ranks newer than yours despite clock skew.
        since: Math.max(context.now(), latestObservedFollowSince + 1),
      };
      // Snap to the target's last known viewport now; its next presence
      // keeps the viewport moving from there.
      const bounds = remoteViewBounds.get(targetPeerId);
      if (bounds) applyViewport(bounds);
      // This follow may have closed a cycle whose edges all carry stamps we
      // had not seen when ours was created; the rule still has to run.
      maybeReleaseFollowCycle();
      // Follow changes are rare and user-visible: bypass the throttle so the
      // target learns it is being followed (and answers with its viewport).
      sendPresence();
      armFollowResend();
    },
    setIdleState(nextIdleState) {
      if (idleState === nextIdleState) return;
      idleState = nextIdleState;
      // Idle transitions are rare and user-visible: bypass the throttle.
      sendPresence();
    },
    setSelection(selectedElementIds) {
      lastSelectedElementIds = selectedElementIds;
    },
    receivePresence(message) {
      collaborators.set(message.senderPeerId, toCollaborator(message));
      scheduleCollaboratorApply();
      const sender = message.senderPeerId;
      const { viewBounds, follow } = message.payload;
      if (viewBounds) {
        remoteViewBounds.set(sender, viewBounds);
        if (selfFollow?.peerId === sender) applyViewport(viewBounds);
      }
      const previousTarget = remoteFollows.get(sender)?.peerId;
      if (follow) {
        remoteFollows.set(sender, follow);
        latestObservedFollowSince = Math.max(
          latestObservedFollowSince,
          follow.since,
        );
      } else {
        remoteFollows.delete(sender);
      }
      // The graph changed under our edge: a peer's new follow may have closed
      // a cycle in which ours is the oldest edge.
      maybeReleaseFollowCycle();
      const selfPeerId = context.connected?.peerId;
      if (
        selfPeerId !== undefined &&
        follow?.peerId === selfPeerId &&
        previousTarget !== selfPeerId
      ) {
        // A peer just started following us. It needs our current viewport
        // even if we are idle, so answer with an immediate sample.
        sendPresence();
      }
      applyFollowedByIfChanged();
    },
    pruneToPeers(knownPeerIds) {
      let membershipChanged = false;
      for (const collaboratorPeerId of [...collaborators.keys()]) {
        if (!knownPeerIds.has(collaboratorPeerId)) {
          collaborators.delete(collaboratorPeerId);
          membershipChanged = true;
        }
      }
      for (const peerId of [...remoteFollows.keys()]) {
        if (!knownPeerIds.has(peerId)) remoteFollows.delete(peerId);
      }
      for (const peerId of [...remoteViewBounds.keys()]) {
        if (!knownPeerIds.has(peerId)) remoteViewBounds.delete(peerId);
      }
      // The engine clears its own `userToFollow` when the followed cursor
      // leaves the collaborator map; releasing here as well stops the session
      // from ever applying a departed peer's stale bounds in the meantime.
      if (selfFollow && !knownPeerIds.has(selfFollow.peerId)) releaseFollow();
      applyFollowedByIfChanged();
      if (membershipChanged) applyCollaborators();
    },
    clear() {
      cancelPendingCollaboratorApply?.();
      cancelPendingCollaboratorApply = undefined;
      cancelTrailing();
      cancelFollowResendTimer();
      remoteFollows.clear();
      remoteViewBounds.clear();
      const follow = options.follow;
      if (follow && appliedFollowedByKey !== "") {
        options.wrapPresenceApply(() => follow.applyFollowedBy([]));
      }
      appliedFollowedByKey = "";
      // No engine write for our own follow target: clearing the collaborator
      // map below makes the engine drop `userToFollow` itself.
      selfFollow = undefined;
      if (collaborators.size > 0) {
        collaborators.clear();
        applyCollaborators();
      }
    },
    cancelPendingApply() {
      cancelPendingCollaboratorApply?.();
      cancelPendingCollaboratorApply = undefined;
      cancelTrailing();
      cancelFollowResendTimer();
    },
    resetForConnection() {
      presenceSequence = 0;
      lastPresenceSentAt = Number.NEGATIVE_INFINITY;
      cancelTrailing();
      cancelFollowResendTimer();
      // Announce this connection's presence without waiting for a pointer
      // sample: the host seeds the viewport before the socket finishes
      // connecting, and a member who never touches the pointer must still
      // show an avatar and be followable.
      if (lastViewBounds) sendPresence();
    },
  };
};
