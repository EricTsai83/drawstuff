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

import type {
  BuildEnvelope,
  SessionContext,
} from "@/lib/collab/session/session-context";

const MAX_PRESENCE_SELECTED_ELEMENT_IDS = 256;
const MAX_PRESENCE_ELEMENT_ID_LENGTH = 64;

type PresencePayload = PresenceMessage["payload"];
export type CollaborationIdleState = PresencePayload["idleState"];

const USER_IDLE_STATE_BY_PRESENCE = {
  active: EXCALIDRAW_USER_IDLE_STATE.ACTIVE,
  idle: EXCALIDRAW_USER_IDLE_STATE.IDLE,
  away: EXCALIDRAW_USER_IDLE_STATE.AWAY,
} as const;

export type PresenceChannel = {
  /** Wire to the editor `onPointerUpdate`: sends bounded-throttle presence. */
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
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

  const sendPresence = (): void => {
    const connected = context.connected;
    if (!connected || !lastPointer) return;
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
    },
    pruneToPeers(knownPeerIds) {
      let membershipChanged = false;
      for (const collaboratorPeerId of [...collaborators.keys()]) {
        if (!knownPeerIds.has(collaboratorPeerId)) {
          collaborators.delete(collaboratorPeerId);
          membershipChanged = true;
        }
      }
      if (membershipChanged) applyCollaborators();
    },
    clear() {
      cancelPendingCollaboratorApply?.();
      cancelPendingCollaboratorApply = undefined;
      if (collaborators.size > 0) {
        collaborators.clear();
        applyCollaborators();
      }
    },
    cancelPendingApply() {
      cancelPendingCollaboratorApply?.();
      cancelPendingCollaboratorApply = undefined;
    },
    resetForConnection() {
      presenceSequence = 0;
      lastPresenceSentAt = Number.NEGATIVE_INFINITY;
    },
  };
};
