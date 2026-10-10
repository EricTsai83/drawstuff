/**
 * React-free orchestration of one collaboration room join: room lookup, canvas
 * handoff, token exchange, canvas claim, session start, and the
 * matching teardown. `useCollaborationRoom` owns the React side — reducer
 * state, refs, and the effect lifetime — and drives this through
 * `start()`/`stop()`. Every dependency that React would otherwise capture in a
 * closure arrives here explicitly, so the sequence can be read and tested
 * without a component around it.
 */

import {
  clearRoomInitializedFromCanvas,
  isCanvasInitializedForRoom,
} from "@/lib/collab/initialized-room-handoff";
import { toast } from "sonner";
import { snapshotReadRequest } from "@/lib/collab/snapshot-http";

import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import type { CanvasHandoffOutcome } from "@/hooks/excalidraw/use-canvas-handoff";
import { toSyncedElements } from "@/lib/collab/element-bridge";
import {
  canvasBelongsToRoom,
  claimCanvasForRoom,
  releaseCanvasRoom,
  readCanvasRoomId,
} from "@/lib/collab/canvas-room-marker";
import {
  FAILURE_MESSAGE_KEY,
  JOIN_RATE_LIMITED_MESSAGE_KEY,
  JOIN_RETRYABLE_MESSAGE_KEY,
  sceneSyncBlockMessage,
  UNREADABLE_ASSETS_MESSAGE_KEY,
} from "@/lib/collab/collaboration-messages";
import type { JoinCredentialsResult } from "@/lib/collab/collaboration-session";
import {
  classifyJoinFailure,
  joinWithRateLimitRetry,
} from "@/lib/collab/join-failure";
import {
  toCollaborationFailureReason,
  type RoomStateAction,
} from "@/lib/collab/room-state-reducer";
import {
  startCollaborationRoomSession,
  toCollaborationUsername,
  type CollaborationRoomHandle,
} from "@/lib/collab/room-session";
import type { AppTranslate } from "@/lib/i18n";
import type { createAuthorityRoomBackend } from "@/lib/collab/authority-client";

type RoomSessionOptions = Parameters<typeof startCollaborationRoomSession>[0];
type RoomLookup = Awaited<
  ReturnType<ReturnType<typeof createAuthorityRoomBackend>["getRoom"]>
>;
type RoomJoin = Awaited<
  ReturnType<ReturnType<typeof createAuthorityRoomBackend>["joinRoom"]>
>;

/**
 * The backend calls the join makes. Adapted from the tRPC client by the hook
 * so that a fresh client identity never restarts a live room, and so the
 * controller stays testable with four plain functions.
 */
type CollaborationRoomBackend = {
  /** Live Room metadata; never a DB role projection. */
  getRoom: (input: { roomId: RoomId }) => Promise<RoomLookup>;
  /** Gets a fresh identity proof; the socket grants the current Room role. */
  joinRoom: (input: { roomId: RoomId }) => Promise<RoomJoin>;
  snapshotApi: RoomSessionOptions["snapshotApi"];
  assetApi: RoomSessionOptions["assetApi"];
};

export type CollaborationRoomControllerDeps = {
  excalidrawApi: ExcalidrawImperativeAPI;
  roomId: RoomId;
  backend: CollaborationRoomBackend;
  /** Every status transition goes through the hook's reducer. */
  dispatch: (action: RoomStateAction) => void;
  /**
   * Read at call time rather than captured: a dictionary swap, a display name
   * arriving with the auth session, or a scene id cleared by the canvas
   * handoff must not tear down and rejoin a live room.
   */
  getTranslate: () => AppTranslate;
  getUsername: () => string | null | undefined;
  getCurrentSceneId: () => string | null;
  /** See `useCanvasHandoff`; the controller only maps its outcome to status. */
  prepareCanvasForRoom: (params: {
    isCancelled: () => boolean;
    keepCanvas?: boolean;
    skipPrompt?: boolean;
    onDecisionPrompt: () => void;
  }) => Promise<CanvasHandoffOutcome>;
  /** Settles a still-open canvas prompt as "cancel" during teardown. */
  cancelPendingCanvasDecision: () => void;
  onSaveStateChange?: RoomSessionOptions["onSaveStateChange"];
  onSourceScene?: (sceneId: string | null) => void;
  restorePersonalCanvas?: () => void;
  wrapRemoteApply: (apply: () => void) => void;
  wrapPresenceApply: (apply: () => void) => void;
  /**
   * Receives the live session handle once it exists and `null` on teardown, so
   * the hook can forward editor events to whatever session is current.
   */
  onHandleChange: (handle: CollaborationRoomHandle | null) => void;
};

export type CollaborationRoomController = {
  /** Runs the join. Never rejects: every failure is reported via `dispatch`. */
  start: () => Promise<void>;
  /** Cancels an in-flight join or ends the live session. */
  stop: () => void;
};

export function createCollaborationRoomController(
  deps: CollaborationRoomControllerDeps,
): CollaborationRoomController {
  const { excalidrawApi, roomId, backend, dispatch } = deps;

  let cancelled = false;
  let handle: CollaborationRoomHandle | undefined;
  let claimedDuringStart = false;
  /** Separates the first join from every reconnect after it. */
  let hasBeenLive = false;

  /**
   * Looks the room up. Returns `null` once the join is over (cancelled).
   * Room refuses an account without access here, before the canvas is
   * prepared, so a refused link never touches the user's work.
   */
  const lookUpRoom = async (): Promise<RoomLookup | null> => {
    // Which scene the room is for decides whether the canvas has to be
    // replaced at all: the owner already has it open.
    const room = await backend.getRoom({ roomId });
    return cancelled ? null : room;
  };

  /**
   * Makes the on-screen canvas this room's scene before anything connects.
   * Returns false when the user declined. The personal draft is preserved
   * before the room baseline replaces the canvas. The
   * canvas sequence itself lives in `useCanvasHandoff`; this maps its outcome
   * onto the room status.
   */
  const prepareCanvas = async (
    keepCanvas = false,
    skipPrompt = false,
  ): Promise<boolean> => {
    const outcome = await deps.prepareCanvasForRoom({
      isCancelled: () => cancelled,
      keepCanvas,
      skipPrompt,
      onDecisionPrompt: () => dispatch({ type: "preparing-canvas" }),
    });
    if (cancelled || outcome === "torn-down") {
      if (outcome === "prepared") deps.restorePersonalCanvas?.();
      return false;
    }
    if (outcome === "declined") {
      dispatch({
        type: "join-blocked",
        status: "cancelled",
        errorMessage: deps.getTranslate()("collaboration.failure.cancelled"),
      });
      return false;
    }
    if (outcome === "save-failed") {
      dispatch({
        type: "join-blocked",
        status: "cancelled",
        errorMessage: deps.getTranslate()(
          "collaboration.failure.saveBeforeJoin",
        ),
      });
      return false;
    }
    dispatch({ type: "join-started" });
    return true;
  };

  /**
   * Waits out a rate-limit window, or gives up the moment the controller is
   * stopped. Resolving on teardown rather than clearing the timer and stranding
   * the promise is what lets the retry loop reach its `isCancelled` check and
   * stop before it can issue another mutation.
   */
  let releaseJoinWait: (() => void) | undefined;
  const waitBeforeRejoin = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        releaseJoinWait = undefined;
        resolve();
      }, ms);
      releaseJoinWait = () => {
        clearTimeout(timer);
        releaseJoinWait = undefined;
        resolve();
      };
    });

  /**
   * Obtains a fresh identity proof. Returns `null` once the join is over —
   * cancelled or rate-limited.
   *
   * The token is fetched imperatively so it is minted immediately before
   * the socket opens: join tokens are short-lived by design.
   *
   * Only this call is retried, never the surrounding bootstrap. Authorization
   * succeeds before canvas preparation or ownership can change.
   */
  const joinRoom = async (): Promise<RoomJoin | null> => {
    const joinOutcome = await joinWithRateLimitRetry({
      attempt: () => backend.joinRoom({ roomId }),
      isCancelled: () => cancelled,
      wait: waitBeforeRejoin,
    });
    if (cancelled || joinOutcome.status === "cancelled") return null;
    if (joinOutcome.status === "rate-limited") {
      // Not `unauthorized`: this link and this account are fine, and the
      // room is joinable again once the window rolls.
      dispatch({
        type: "join-blocked",
        status: "rate-limited",
        errorMessage: deps.getTranslate()(JOIN_RATE_LIMITED_MESSAGE_KEY),
      });
      return null;
    }
    return joinOutcome.value;
  };

  /**
   * Mints credentials for a reconnect attempt, and classifies a refusal.
   *
   * The classification has to happen here, where the backend's error
   * vocabulary is: a `FORBIDDEN`/`NOT_FOUND` answer means this client is no
   * longer allowed in and recovery must stop, while anything else — a
   * timeout, a 5xx, an offline browser — is a condition the next attempt may
   * not hit. Getting that backwards either hides a revocation behind an
   * endless spinner or abandons a session that would have come back.
   */
  const refreshJoinToken = async (): Promise<JoinCredentialsResult> => {
    try {
      const refreshed = await backend.joinRoom({ roomId });
      return { ok: true, token: refreshed.token };
    } catch (error) {
      return classifyJoinFailure(error);
    }
  };

  /**
   * Opens the relay session and wires its reports onto the room status. The
   * canvas is already claimed when this runs, so the session's first inbound
   * frame lands on a canvas that is the room's.
   */
  const openSession = (joined: RoomJoin): CollaborationRoomHandle =>
    startCollaborationRoomSession({
      excalidrawApi,
      relayUrl: joined.relayUrl,
      roomId: joined.roomId,
      joinToken: joined.token,
      refreshJoinToken,
      username: toCollaborationUsername(deps.getUsername()),
      snapshotApi: backend.snapshotApi,
      assetApi: backend.assetApi,
      onSaveStateChange: (state) => {
        if (!cancelled) deps.onSaveStateChange?.(state);
      },
      wrapRemoteApply: deps.wrapRemoteApply,
      wrapPresenceApply: deps.wrapPresenceApply,
      canSyncScene: () => canvasBelongsToRoom(joined.roomId),
      // Role only: the granted role is a property of the socket, and it must
      // survive a reconnect window so a viewer's editor does not briefly
      // become writable while the session is retrying.
      onConnectionStateChange: (connectionState) => {
        if (cancelled) return;
        if (connectionState.status === "connected") {
          // The server just stated the role, so it is authoritative again.
          dispatch({ type: "role-granted", role: connectionState.role });
          return;
        }
        // Access was withdrawn; the reconnect lets Room confirm it. A
        // `roleChanged` close reads as transient and keeps the role until
        // the reconnect grants the new one.
        if (
          connectionState.status === "disconnected" &&
          connectionState.reason === "membership-revoked"
        ) {
          dispatch({ type: "role-withdrawn" });
        }
      },
      onSceneSyncBlockChange: (block) => {
        // Two surfaces, mirroring upstream's split in
        // `excalidraw-app/collab/Collab.tsx`: an announcement at the moment
        // of failure plus a persistent indicator. Upstream's `ErrorDialog` is
        // rendered by the collab component itself, so it reaches every
        // viewport. Drawstuff also keeps the persistent indicator in its
        // compact, regular and wide product-action presentations; the
        // announcement still reports the transition immediately.
        //
        // Announced once per transition, which is what upstream's
        // `dialogNotifiedErrors` map buys: the session only reports a change
        // of state, never a repeat. And as upstream does with
        // `|| !this.isCollaborating()`, a block first discovered during
        // teardown is still announced even though the status surface is
        // already gone — for the leave flush that is the last word on whether
        // the room's only copy of the work was stored.
        if (block)
          toast.warning(sceneSyncBlockMessage(block, deps.getTranslate()));
        if (cancelled) return;
        dispatch({ type: "sync-block-changed", block });
      },
      // Same two surfaces as the block above, for the same reason: the
      // persistent message lives in a status area the editor does not render
      // on every viewport, so the announcement has to be layout-independent.
      // The store reports this at most once per session, so neither surface
      // needs its own deduplication.
      onAssetsUnreadable: () => {
        toast.warning(deps.getTranslate()(UNREADABLE_ASSETS_MESSAGE_KEY));
        if (cancelled) return;
        dispatch({ type: "assets-unreadable" });
      },
      onRecoveryStateChange: (recoveryState) => {
        if (cancelled) return;
        if (recoveryState.phase === "failed") {
          const reason = toCollaborationFailureReason(recoveryState.reason);
          dispatch({
            type: "failed",
            reason,
            errorMessage: deps.getTranslate()(FAILURE_MESSAGE_KEY[reason]),
          });
          return;
        }
        if (recoveryState.phase === "live") {
          hasBeenLive = true;
          dispatch({ type: "recovery-progressed", status: "connected" });
          return;
        }
        if (recoveryState.phase === "idle") {
          dispatch({ type: "recovery-progressed", status: "idle" });
          return;
        }
        // Before the first successful join this is still the join; after it,
        // it is a reconnect. The difference is the whole point of the status:
        // "this is slow" versus "this broke and is coming back".
        dispatch({
          type: "recovery-progressed",
          status: hasBeenLive ? "reconnecting" : "joining",
        });
      },
    });

  /**
   * A synchronous/asynchronous failure while constructing the session is
   * still a failed join. Releases only the claim made by this start path;
   * successful sessions are released by `stop()`.
   */
  const reportStartFailure = (error: unknown): void => {
    if (cancelled) return;
    if (claimedDuringStart) {
      releaseCanvasRoom();
      deps.restorePersonalCanvas?.();
      claimedDuringStart = false;
      dispatch({ type: "canvas-released" });
    }
    // Classified the same way a reconnect refusal is, and never shown raw:
    // only a stated authorization verdict may read as one. Everything else
    // — an offline browser, a 5xx — is retryable, and reporting it as a
    // refusal sends the user to ask for access they already have.
    const refusal = classifyJoinFailure(error);
    if (!refusal.ok && !refusal.retry) {
      if (refusal.failure === "unauthorized") {
        dispatch({
          type: "join-blocked",
          status: "unauthorized",
          errorMessage: deps.getTranslate()(FAILURE_MESSAGE_KEY.unauthorized),
        });
        return;
      }
      // The same terminal verdict recovery would report for this room:
      // `room-ended`, or `no-access` for an account Room refuses.
      const reason = toCollaborationFailureReason(refusal.failure);
      dispatch({
        type: "failed",
        reason,
        errorMessage: deps.getTranslate()(FAILURE_MESSAGE_KEY[reason]),
      });
      return;
    }
    dispatch({
      type: "join-blocked",
      status: "join-failed",
      errorMessage: deps.getTranslate()(JOIN_RETRYABLE_MESSAGE_KEY),
    });
  };

  const start = async (): Promise<void> => {
    dispatch({ type: "join-started" });
    try {
      const room = await lookUpRoom();
      if (!room) return;
      const joined = await joinRoom();
      if (!joined || cancelled) return;
      const reloading = readCanvasRoomId() === roomId;
      const isOpenScene =
        room.sceneId !== null && room.sceneId === deps.getCurrentSceneId();
      deps.onSourceScene?.(
        isOpenScene && joined.role === "owner" ? room.sceneId : null,
      );
      const stored = await backend.snapshotApi.read(
        snapshotReadRequest(roomId),
      );
      if (cancelled) return;
      // Checked after every await before the handoff: an edited or replaced
      // canvas is no longer the one this tab stored into the room.
      const initializedHere = isCanvasInitializedForRoom(
        roomId,
        toSyncedElements(excalidrawApi.getSceneElementsIncludingDeleted()),
      );
      // Only an empty fresh room may be seeded from its owner's source canvas.
      if (
        !(await prepareCanvas(
          isOpenScene &&
            !reloading &&
            !stored.found &&
            stored.receipt.revision === 0,
          reloading || isOpenScene || initializedHere,
        ))
      )
        return;
      clearRoomInitializedFromCanvas(roomId);
      if (cancelled) return;
      // Commit the canvas claim only after the join succeeds. No socket
      // exists yet, so this is still before the first inbound frame; a
      // refused/exhausted join no longer leaves a tab in collaboration-owned
      // mode without a session.
      claimCanvasForRoom(roomId);
      claimedDuringStart = true;
      dispatch({ type: "canvas-claimed" });
      handle = openSession(joined);
      deps.onHandleChange(handle);
    } catch (error) {
      reportStartFailure(error);
    }
  };

  const stop = (): void => {
    cancelled = true;
    // Ends any rate-limit wait immediately; the loop then sees `cancelled`
    // and returns without another join.
    releaseJoinWait?.();
    // A teardown while the user was still deciding must not strand the
    // scene-change dialog: nothing else would resolve the pending promise or
    // close it. Resolving as "cancel" keeps their canvas untouched.
    deps.cancelPendingCanvasDecision();
    deps.onHandleChange(null);
    // The leave flush outlives this teardown by design; React cannot await it.
    void handle?.destroy();
    // The canvas is no longer a room's scene: dropping the claim stops any
    // late callback from writing room state onto it.
    if (claimedDuringStart && canvasBelongsToRoom(roomId)) {
      releaseCanvasRoom();
      deps.restorePersonalCanvas?.();
    }
    dispatch({ type: "torn-down" });
  };

  return { start, stop };
}
