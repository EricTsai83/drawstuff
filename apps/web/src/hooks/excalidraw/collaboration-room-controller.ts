/**
 * React-free orchestration of one collaboration room join: room lookup and key
 * check, canvas handoff, token exchange, canvas claim, session start, and the
 * matching teardown. `useCollaborationRoom` owns the React side — reducer
 * state, refs, and the effect lifetime — and drives this through
 * `start()`/`stop()`. Every dependency that React would otherwise capture in a
 * closure arrives here explicitly, so the sequence can be read and tested
 * without a component around it.
 */

import { toast } from "sonner";

import { verifyRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import type { CanvasHandoffOutcome } from "@/hooks/excalidraw/use-canvas-handoff";
import {
  canvasBelongsToRoom,
  claimCanvasForRoom,
  releaseCanvasRoom,
} from "@/lib/collab/canvas-room-marker";
import {
  FAILURE_MESSAGE_KEY,
  JOIN_RATE_LIMITED_MESSAGE_KEY,
  JOIN_RETRYABLE_MESSAGE_KEY,
  MISSING_KEY_CHECK_MESSAGE_KEY,
  sceneSyncBlockMessage,
  UNREADABLE_ASSETS_MESSAGE_KEY,
  WRONG_KEY_LINK_MESSAGE_KEY,
} from "@/lib/collab/collaboration-messages";
import type { JoinCredentialsResult } from "@/lib/collab/collaboration-session";
import {
  classifyJoinFailure,
  joinWithRateLimitRetry,
} from "@/lib/collab/join-failure";
import type { RoomStateAction } from "@/lib/collab/room-state-reducer";
import {
  startCollaborationRoomSession,
  toCollaborationUsername,
  type CollaborationRoomHandle,
} from "@/lib/collab/room-session";
import type { AppTranslate } from "@/lib/i18n";
import type { RouterOutputs } from "@/trpc/react";

type RoomSessionOptions = Parameters<typeof startCollaborationRoomSession>[0];
type RoomLookup = RouterOutputs["collaborationRoom"]["get"];
type RoomJoin = RouterOutputs["collaborationRoom"]["join"];

/**
 * The backend calls the join makes. Adapted from the tRPC client by the hook
 * so that a fresh client identity never restarts a live room, and so the
 * controller stays testable with four plain functions.
 */
export type CollaborationRoomBackend = {
  /** `collaborationRoom.get`: which scene the room is for, plus its key check. */
  getRoom: (input: { roomId: RoomId }) => Promise<RoomLookup>;
  /** `collaborationRoom.join`: mints a short-lived join token. */
  joinRoom: (input: { roomId: RoomId }) => Promise<RoomJoin>;
  snapshotApi: RoomSessionOptions["snapshotApi"];
  assetApi: RoomSessionOptions["assetApi"];
};

export type CollaborationRoomControllerDeps = {
  excalidrawApi: ExcalidrawImperativeAPI;
  roomId: RoomId;
  /** End-to-end room key from the URL fragment; never sent to the backend. */
  roomKey: RoomKey;
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
    onDecisionPrompt: () => void;
  }) => Promise<CanvasHandoffOutcome>;
  /** Settles a still-open canvas prompt as "cancel" during teardown. */
  cancelPendingCanvasDecision: () => void;
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
  const { excalidrawApi, roomId, roomKey, backend, dispatch } = deps;

  let cancelled = false;
  let handle: CollaborationRoomHandle | undefined;
  let claimedDuringStart = false;
  /** Separates the first join from every reconnect after it. */
  let hasBeenLive = false;

  /**
   * Looks the room up and verifies the link's key against its stored check.
   * Returns `null` once the join is over — cancelled, or a failure dispatched.
   *
   * The key check comes before anything else the join does: before the
   * canvas is prepared (so a wrong-key link never clears the user's
   * work), before the claim, and before any token is minted. A link that
   * fails it could only ever produce a session that is blind to the room
   * and — in an empty room — would poison it with a snapshot nobody else
   * can open.
   */
  const lookUpRoom = async (): Promise<RoomLookup | null> => {
    // Which scene the room is for decides whether the canvas has to be
    // replaced at all: the owner already has it open.
    const room = await backend.getRoom({ roomId });
    if (cancelled) return null;
    if (room.keyCheckBase64 === null) {
      dispatch({
        type: "failed",
        reason: "missing-key-check",
        errorMessage: deps.getTranslate()(MISSING_KEY_CHECK_MESSAGE_KEY),
      });
      return null;
    }
    const keyCheckOk = await verifyRoomKeyCheck({
      roomKey,
      roomId,
      authGeneration: room.authGeneration,
      keyCheckBase64: room.keyCheckBase64,
    });
    if (cancelled) return null;
    if (!keyCheckOk) {
      dispatch({
        type: "failed",
        reason: "wrong-key-link",
        errorMessage: deps.getTranslate()(WRONG_KEY_LINK_MESSAGE_KEY),
      });
      return null;
    }
    return room;
  };

  /**
   * Makes the on-screen canvas this room's scene before anything connects.
   * Returns false when the user declined, which is the only way to keep their
   * work: once the canvas is claimed the room's baseline replaces it. The
   * canvas sequence itself lives in `useCanvasHandoff`; this maps its outcome
   * onto the room status.
   */
  const prepareCanvas = async (): Promise<boolean> => {
    const outcome = await deps.prepareCanvasForRoom({
      isCancelled: () => cancelled,
      onDecisionPrompt: () => dispatch({ type: "preparing-canvas" }),
    });
    if (cancelled || outcome === "torn-down") return false;
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
   * Exchanges the room id for a join token and checks the token's generation
   * against the one the key was verified for. Returns `null` once the join is
   * over — cancelled, rate-limited, or refused for a rotated generation.
   *
   * The token is fetched imperatively so it is minted immediately before
   * the socket opens: join tokens are short-lived by design.
   *
   * Only this call is retried, never the bootstrap around it: the canvas
   * has already been prepared and claimed by the time it runs, and re-running
   * that would re-prompt the user for work they already gave up.
   */
  const joinRoom = async (room: RoomLookup): Promise<RoomJoin | null> => {
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
    const joined = joinOutcome.value;
    // The key check was verified against the generation `get` reported, and
    // the user may have sat in the canvas prompt between then and now — time
    // enough for the owner to rotate. A join that comes back on a different
    // generation would start a session whose key was never verified for it
    // (and, in an empty generation, would seed a snapshot under that
    // unverified key), so it is refused here. An equal generation is safe:
    // the check value is immutable within a generation, and a rotation
    // *after* this point disconnects the session, whose token refresh
    // detects the moved generation.
    if (joined.authGeneration !== room.authGeneration) {
      dispatch({
        type: "failed",
        reason: "generation-rotated",
        errorMessage: deps.getTranslate()(
          FAILURE_MESSAGE_KEY["generation-rotated"],
        ),
      });
      return null;
    }
    return joined;
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
      return {
        ok: true,
        token: refreshed.token,
        authGeneration: refreshed.authGeneration,
      };
    } catch (error) {
      return classifyJoinFailure(error);
    }
  };

  /**
   * Opens the relay session and wires its reports onto the room status. The
   * canvas is already claimed when this runs, so the session's first inbound
   * frame lands on a canvas that is the room's.
   */
  const openSession = (joined: RoomJoin): Promise<CollaborationRoomHandle> =>
    startCollaborationRoomSession({
      excalidrawApi,
      relayUrl: joined.relayUrl,
      roomId: joined.roomId,
      joinToken: joined.token,
      refreshJoinToken,
      roomKey,
      authGeneration: joined.authGeneration,
      username: toCollaborationUsername(deps.getUsername()),
      snapshotApi: backend.snapshotApi,
      assetApi: backend.assetApi,
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
          dispatch({
            type: "failed",
            reason: recoveryState.reason,
            errorMessage: deps.getTranslate()(
              FAILURE_MESSAGE_KEY[recoveryState.reason],
            ),
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
      claimedDuringStart = false;
      dispatch({ type: "canvas-released" });
    }
    // Classified the same way a reconnect refusal is, and never shown raw:
    // only a stated authorization verdict may read as one. Everything else
    // — an offline browser, a 5xx, a failed key derivation — is retryable,
    // and reporting it as `unauthorized` sends the user to ask for access
    // they already have.
    const refusal = classifyJoinFailure(error);
    if (!refusal.ok && !refusal.retry) {
      if (refusal.failure === "room-ended") {
        // The same terminal verdict recovery would report for this room.
        dispatch({
          type: "failed",
          reason: "room-ended",
          errorMessage: deps.getTranslate()(FAILURE_MESSAGE_KEY["room-ended"]),
        });
        return;
      }
      dispatch({
        type: "join-blocked",
        status: "unauthorized",
        errorMessage: deps.getTranslate()(FAILURE_MESSAGE_KEY[refusal.failure]),
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
      const isOpenScene = room.sceneId === deps.getCurrentSceneId();
      // The claim is deliberately *not* used to skip this. It is per tab, but
      // the restored canvas in localStorage is not: another tab that loaded an
      // unrelated scene leaves this tab's claim intact while replacing the
      // canvas it points at, so a reload would hand that unrelated scene to the
      // room. Asking again is the only answer that cannot be wrong.
      if (!isOpenScene && !(await prepareCanvas())) return;
      if (cancelled) return;
      const joined = await joinRoom(room);
      if (!joined) return;
      // Commit the canvas claim only after join and generation validation
      // succeed. No socket exists yet, so this is still before the first
      // inbound frame; a refused/exhausted join no longer leaves a tab in
      // collaboration-owned mode without a session.
      claimCanvasForRoom(roomId);
      claimedDuringStart = true;
      dispatch({ type: "canvas-claimed" });
      // Key derivation is asynchronous, so the controller can be stopped while
      // the session is still being built. Whatever comes back has to be
      // destroyed in that case: the `handle` variable `stop()` reads is still
      // undefined at that point.
      const started = await openSession(joined);
      if (cancelled) {
        void started.destroy();
        return;
      }
      handle = started;
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
    releaseCanvasRoom();
    dispatch({ type: "torn-down" });
  };

  return { start, stop };
}
