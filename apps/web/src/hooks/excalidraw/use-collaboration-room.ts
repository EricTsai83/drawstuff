"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

import { verifyRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  roomRoleCanEditScene,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import {
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useAppI18n } from "@/hooks/use-app-i18n";
import {
  canvasBelongsToRoom,
  claimCanvasForRoom,
  releaseCanvasRoom,
} from "@/lib/collab/canvas-room-marker";
import { uploadCollaborationAsset } from "@/lib/collab/asset-upload";
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
import type { CanvasHandoffOutcome } from "@/hooks/excalidraw/use-canvas-handoff";
import {
  classifyJoinFailure,
  joinWithRateLimitRetry,
} from "@/lib/collab/join-failure";
import {
  initialRoomState,
  roomStateReducer,
  type CollaborationFailureReason,
  type CollaborationRoomStatus,
} from "@/lib/collab/room-state-reducer";
import {
  startCollaborationRoomSession,
  toCollaborationUsername,
  type CollaborationRoomHandle,
} from "@/lib/collab/room-session";
import { api } from "@/trpc/react";

export type {
  CollaborationFailureReason,
  CollaborationRoomStatus,
} from "@/lib/collab/room-state-reducer";

/**
 * Drives one collaboration room from the editor: prepares the canvas, exchanges
 * the room id for a short-lived join token, starts the relay session, and mirrors
 * the granted role as read-only editor state.
 *
 * The room id is a locator only — the backend decides the role, and a viewer's
 * session is read-only on the server whatever this hook reports.
 *
 * The pieces live where they can be tested without React: the join-failure
 * classification and the bounded bootstrap retry in `lib/collab/join-failure.ts`,
 * the user-facing wording in `lib/collab/collaboration-messages.ts`, and the
 * state machine in `lib/collab/room-state-reducer.ts`. This hook owns the
 * effect: canvas preparation, the join exchange, session wiring and teardown.
 *
 * ## Losing the connection
 *
 * A dropped socket reconnects on its own, with backoff and a freshly minted join
 * token, and the status says so. What it must never do is retry indefinitely
 * without saying anything: a revoked membership, an ended room and a rotated
 * generation all end a session for good, and each of them looks exactly like a
 * network blip until the reason is reported. So the user-facing status follows the
 * session's *recovery* state rather than its socket state — `reconnecting` and
 * `failed` are both a closed socket, and only one of them is worth waiting for.
 *
 * Authorization and confidentiality arrive from opposite directions. The join
 * token comes from the backend; the room key comes from the URL fragment and is
 * never sent anywhere. A link without a usable key therefore cannot open a
 * session at all — reporting `missing-room-key` is the only option, because a
 * session without the key could neither read nor write the room.
 *
 * ## Joining a room whose scene you do not have
 *
 * A session publishes the local canvas once it is synced, so joining with an
 * unrelated scene loaded would push that scene's content into the room. The
 * leak is closed by making the canvas the room's *before* the socket opens:
 *
 * 1. Unsaved local work is resolved through the editor's existing
 *    save/discard/cancel prompt. Cancelling means no connection is attempted.
 * 2. The canvas is emptied and the scene session cleared, which also drops the
 *    guest's `currentSceneId`. A guest must never adopt the owner's scene id —
 *    its own save would then try to overwrite somebody else's scene.
 * 3. The join mutation succeeds and its authorization generation is checked.
 *    A refused or exhausted join therefore leaves no collaboration ownership
 *    marker behind.
 * 4. The canvas is claimed for the room, and only then does the session connect
 *    and receive the room's baseline from an elected peer or from the durable
 *    snapshot.
 *
 * Because step 2 leaves the guest without a scene id, `canSyncScene` cannot be a
 * scene-id comparison any more; it is the canvas claim from step 4.
 */
export type UseCollaborationRoomResult = {
  status: CollaborationRoomStatus;
  /** Set while `status` is `failed`; `null` otherwise. */
  failureReason: CollaborationFailureReason | null;
  role: RoomRole | null;
  isCollaborating: boolean;
  /** True while connected as a viewer: the editor renders in view mode. */
  isReadOnly: boolean;
  errorMessage: string | null;
  /**
   * True while a room owns the on-screen canvas, including the join window before
   * the relay reports `connected`. The editor withholds canvas-replacing actions
   * that the session cannot observe (upstream's file import) while this holds.
   */
  ownsCanvas: boolean;
  /**
   * Tears the current attempt down and joins again with the same link. Exists
   * for the states an action can genuinely repair — the owner resetting an
   * unreadable snapshot being the one that motivated it — where "reload the
   * page" was previously the only way to re-run the join.
   */
  retryJoin: () => void;
  onPointerUpdate: (payload: ExcalidrawPointerUpdatePayload) => void;
  onSceneChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ) => void;
};

export function useCollaborationRoom(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** Room id from the shareable link; `null` disables collaboration. */
  roomId: string | null;
  /**
   * End-to-end room key from the URL fragment. `null` while a room id is set
   * means the link is incomplete, which is a hard stop rather than a downgrade.
   */
  roomKey: RoomKey | null;
  /** Cloud scene id currently open in the editor, if any. */
  currentSceneId: string | null;
  /** Display name for presence; falls back to a per-client guest label. */
  username: string | null | undefined;
  /** Collaboration requires an authenticated session. */
  isAuthenticated: boolean;
  /**
   * Makes the on-screen canvas this room's scene before anything connects:
   * unsaved work is resolved through the editor's prompt, then the scene
   * session and the canvas are cleared. See `useCanvasHandoff`, which owns the
   * whole sequence — this hook only consumes the outcome.
   */
  prepareCanvasForRoom: (params: {
    isCancelled: () => boolean;
    onDecisionPrompt: () => void;
  }) => Promise<CanvasHandoffOutcome>;
  /**
   * Settles a still-open canvas prompt as "cancel" and closes it. The join
   * effect's cleanup calls this — a teardown mid-decision otherwise leaves the
   * dialog open forever, with nobody awaiting the answer.
   */
  cancelPendingCanvasDecision: () => void;
}): UseCollaborationRoomResult {
  const {
    excalidrawAPI,
    roomId,
    roomKey,
    username,
    isAuthenticated,
    // Used only to decide whether the local canvas cache is still meaningful;
    // the join effect deliberately reads this through `canvasRef` instead.
    currentSceneId,
  } = options;
  const { t } = useAppI18n();
  const tRef = useRef(t);
  const { suppressDirtyTracking, resumeDirtyTracking } = useSceneSession();
  const utils = api.useUtils();

  const handleRef = useRef<CollaborationRoomHandle | null>(null);
  /**
   * Re-running the join is a state change, not a callback: the join lives in
   * an effect, so the retry bumps a counter the effect depends on, which tears
   * the failed attempt down through the normal cleanup and starts over.
   */
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [state, dispatch] = useReducer(roomStateReducer, initialRoomState);
  const { status, syncBlock, assetsUnreadable, ownsCanvas } = state;

  /**
   * Read at connect time instead of being effect dependencies: a display name
   * that arrives with the auth session, a new tRPC utils identity, or a
   * re-created editor callback must not tear down and rejoin a live room.
   *
   * `currentSceneId` is in here for a sharper reason. Preparing the canvas
   * *clears* the scene session, so treating it as a dependency would make the
   * join re-trigger itself: connect, clear, re-render, tear down, connect again.
   * The session's ongoing "is this still my canvas?" question is answered by the
   * canvas claim (`canvasBelongsToRoom`), not by this id — the id only decides,
   * once, whether the canvas has to be replaced at all.
   */
  const usernameRef = useRef(username);
  const utilsRef = useRef(utils);
  const canvasRef = useRef(options);
  // Synchronized after commit rather than assigned in the render body: a
  // concurrent render that is thrown away must not leave its uncommitted
  // values behind in the refs. Declared before the join effect so the refs are
  // current by the time it runs.
  useEffect(() => {
    tRef.current = t;
    usernameRef.current = username;
    utilsRef.current = utils;
    canvasRef.current = options;
  });

  // Remote input must not mark the scene dirty: suppress tracking for the
  // synchronous onChange the write triggers and resume one frame later
  // (same pattern as use-apply-remote-scene.ts).
  const wrapRemoteApply = useCallback(
    (apply: () => void) => {
      suppressDirtyTracking();
      try {
        apply();
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
    },
    [suppressDirtyTracking, resumeDirtyTracking],
  );

  // Presence-only writes release their hold synchronously instead. They arrive
  // at ~30fps per peer, so a frame-deferred resume would keep a suppression
  // window open continuously in any room with two members — and a local edit
  // landing inside it would never mark the scene dirty.
  const wrapPresenceApply = useCallback(
    (apply: () => void) => {
      suppressDirtyTracking();
      try {
        apply();
      } finally {
        resumeDirtyTracking();
      }
    },
    [suppressDirtyTracking, resumeDirtyTracking],
  );

  /**
   * Stops caching the canvas locally while a room owns it and no owned scene
   * backs it.
   *
   * Upstream pauses its local persistence for the whole collaboration session
   * (`LocalData.pauseSave("collaboration")`). Drawstuff cannot copy that
   * unconditionally: our browser storage is a cache of an owned cloud scene, so
   * pausing it for the room *owner* would leave a stale cache that a reload
   * restores and the next save uploads over their newer cloud scene. For a guest
   * there is no such scene, so the cache has nothing to be a cache of — and
   * leaving it on would write another user's room content to this machine and
   * let a collaborating tab overwrite an unrelated tab's cached canvas.
   *
   * Re-evaluated when the guest saves a copy: from that point there *is* an owned
   * scene, the room's content is legitimately its content, and caching resumes.
   */
  useEffect(() => {
    if (!ownsCanvas || currentSceneId) return;
    pauseLocalScenePersistence("collaboration-guest-canvas");
    return () => {
      resumeLocalScenePersistence("collaboration-guest-canvas");
    };
  }, [ownsCanvas, currentSceneId]);

  useEffect(() => {
    if (!excalidrawAPI || !roomId || !isAuthenticated) return;
    const parsedRoomId = roomIdSchema.safeParse(roomId);
    if (!parsedRoomId.success) {
      dispatch({
        type: "join-blocked",
        status: "unauthorized",
        errorMessage: tRef.current("collaboration.failure.invalidLink"),
      });
      return;
    }
    // Checked before any token is requested: without the key there is nothing a
    // session could do, and asking the backend for a token would only advertise
    // an attempt. The message never echoes the fragment.
    if (!roomKey) {
      dispatch({
        type: "join-blocked",
        status: "missing-room-key",
        errorMessage: tRef.current("collaboration.failure.missingRoomKey"),
      });
      return;
    }

    let cancelled = false;
    let handle: CollaborationRoomHandle | undefined;
    let claimedDuringStart = false;
    /** Separates the first join from every reconnect after it. */
    let hasBeenLive = false;
    dispatch({ type: "join-started" });

    /**
     * Makes the on-screen canvas this room's scene before anything connects.
     * Returns false when the user declined, which is the only way to keep their
     * work: once the canvas is claimed the room's baseline replaces it. The
     * canvas sequence itself lives in `useCanvasHandoff`; this maps its outcome
     * onto the room status.
     */
    const prepareCanvas = async (): Promise<boolean> => {
      const outcome = await canvasRef.current.prepareCanvasForRoom({
        isCancelled: () => cancelled,
        onDecisionPrompt: () => dispatch({ type: "preparing-canvas" }),
      });
      if (cancelled || outcome === "torn-down") return false;
      if (outcome === "declined") {
        dispatch({
          type: "join-blocked",
          status: "cancelled",
          errorMessage: tRef.current("collaboration.failure.cancelled"),
        });
        return false;
      }
      if (outcome === "save-failed") {
        dispatch({
          type: "join-blocked",
          status: "cancelled",
          errorMessage: tRef.current("collaboration.failure.saveBeforeJoin"),
        });
        return false;
      }
      dispatch({ type: "join-started" });
      return true;
    };

    /**
     * Waits out a rate-limit window, or gives up the moment the effect is torn
     * down. Resolving on teardown rather than clearing the timer and stranding
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

    const start = async (): Promise<void> => {
      try {
        // Which scene the room is for decides whether the canvas has to be
        // replaced at all: the owner already has it open.
        const room = await utilsRef.current.client.collaborationRoom.get.query({
          roomId: parsedRoomId.data,
        });
        if (cancelled) return;
        // The key check comes before anything else the join does: before the
        // canvas is prepared (so a wrong-key link never clears the user's
        // work), before the claim, and before any token is minted. A link that
        // fails it could only ever produce a session that is blind to the room
        // and — in an empty room — would poison it with a snapshot nobody else
        // can open.
        if (room.keyCheckBase64 === null) {
          dispatch({
            type: "failed",
            reason: "missing-key-check",
            errorMessage: tRef.current(MISSING_KEY_CHECK_MESSAGE_KEY),
          });
          return;
        }
        const keyCheckOk = await verifyRoomKeyCheck({
          roomKey,
          roomId: parsedRoomId.data,
          authGeneration: room.authGeneration,
          keyCheckBase64: room.keyCheckBase64,
        });
        if (cancelled) return;
        if (!keyCheckOk) {
          dispatch({
            type: "failed",
            reason: "wrong-key-link",
            errorMessage: tRef.current(WRONG_KEY_LINK_MESSAGE_KEY),
          });
          return;
        }
        const isOpenScene = room.sceneId === canvasRef.current.currentSceneId;
        // The claim is deliberately *not* used to skip this. It is per tab, but
        // the restored canvas in localStorage is not: another tab that loaded an
        // unrelated scene leaves this tab's claim intact while replacing the
        // canvas it points at, so a reload would hand that unrelated scene to the
        // room. Asking again is the only answer that cannot be wrong.
        if (!isOpenScene && !(await prepareCanvas())) return;
        if (cancelled) return;
        // The token is fetched imperatively so it is minted immediately before
        // the socket opens: join tokens are short-lived by design.
        //
        // Only this call is retried, never the bootstrap around it: the canvas
        // above has already been prepared and claimed, and re-running that would
        // re-prompt the user for work they already gave up.
        const joinOutcome = await joinWithRateLimitRetry({
          attempt: () =>
            utilsRef.current.client.collaborationRoom.join.mutate({
              roomId: parsedRoomId.data,
            }),
          isCancelled: () => cancelled,
          wait: waitBeforeRejoin,
        });
        if (cancelled || joinOutcome.status === "cancelled") return;
        if (joinOutcome.status === "rate-limited") {
          // Not `unauthorized`: this link and this account are fine, and the
          // room is joinable again once the window rolls.
          dispatch({
            type: "join-blocked",
            status: "rate-limited",
            errorMessage: tRef.current(JOIN_RATE_LIMITED_MESSAGE_KEY),
          });
          return;
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
            errorMessage: tRef.current(
              FAILURE_MESSAGE_KEY["generation-rotated"],
            ),
          });
          return;
        }
        // Commit the canvas claim only after join and generation validation
        // succeed. No socket exists yet, so this is still before the first
        // inbound frame; a refused/exhausted join no longer leaves a tab in
        // collaboration-owned mode without a session.
        claimCanvasForRoom(parsedRoomId.data);
        claimedDuringStart = true;
        dispatch({ type: "canvas-claimed" });
        // Key derivation is asynchronous, so the effect can be torn down while
        // the session is still being built. Whatever comes back has to be
        // destroyed in that case: the closure variable the cleanup reads is
        // still undefined at that point.
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
            const refreshed =
              await utilsRef.current.client.collaborationRoom.join.mutate({
                roomId: parsedRoomId.data,
              });
            return {
              ok: true,
              token: refreshed.token,
              authGeneration: refreshed.authGeneration,
            };
          } catch (error) {
            return classifyJoinFailure(error);
          }
        };

        const started = await startCollaborationRoomSession({
          excalidrawApi: excalidrawAPI,
          relayUrl: joined.relayUrl,
          roomId: joined.roomId,
          joinToken: joined.token,
          refreshJoinToken,
          roomKey,
          authGeneration: joined.authGeneration,
          username: toCollaborationUsername(usernameRef.current),
          // Adapted rather than passed through: the store's contract is two
          // plain async functions, which keeps it testable without tRPC.
          snapshotApi: {
            get: (input) =>
              utilsRef.current.client.collaborationSnapshot.get.query(input),
            put: (input) =>
              utilsRef.current.client.collaborationSnapshot.put.mutate(input),
          },
          // Same shape, and for the same reason: the store needs two plain async
          // functions, one to find out where a room's ciphertext lives and one to
          // put ciphertext there. Neither can read what it carries.
          assetApi: {
            resolve: (input, signal) =>
              utilsRef.current.client.collaborationAsset.resolve.query(input, {
                signal,
              }),
            upload: uploadCollaborationAsset,
          },
          wrapRemoteApply,
          wrapPresenceApply,
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
              toast.warning(sceneSyncBlockMessage(block, tRef.current));
            if (cancelled) return;
            dispatch({ type: "sync-block-changed", block });
          },
          // Same two surfaces as the block above, for the same reason: the
          // persistent message lives in a status area the editor does not render
          // on every viewport, so the announcement has to be layout-independent.
          // The store reports this at most once per session, so neither surface
          // needs its own deduplication.
          onAssetsUnreadable: () => {
            toast.warning(tRef.current(UNREADABLE_ASSETS_MESSAGE_KEY));
            if (cancelled) return;
            dispatch({ type: "assets-unreadable" });
          },
          onRecoveryStateChange: (recoveryState) => {
            if (cancelled) return;
            if (recoveryState.phase === "failed") {
              dispatch({
                type: "failed",
                reason: recoveryState.reason,
                errorMessage: tRef.current(
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
        if (cancelled) {
          void started.destroy();
          return;
        }
        handle = started;
        handleRef.current = handle;
      } catch (error) {
        if (cancelled) return;
        // A synchronous/asynchronous failure while constructing the session is
        // still a failed join. Release only the claim made by this start path;
        // successful sessions are released by the effect cleanup below.
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
              errorMessage: tRef.current(FAILURE_MESSAGE_KEY["room-ended"]),
            });
            return;
          }
          dispatch({
            type: "join-blocked",
            status: "unauthorized",
            errorMessage: tRef.current(FAILURE_MESSAGE_KEY[refusal.failure]),
          });
          return;
        }
        dispatch({
          type: "join-blocked",
          status: "join-failed",
          errorMessage: tRef.current(JOIN_RETRYABLE_MESSAGE_KEY),
        });
      }
    };
    void start();

    return () => {
      cancelled = true;
      // Ends any rate-limit wait immediately; the loop then sees `cancelled`
      // and returns without another join.
      releaseJoinWait?.();
      // A teardown while the user was still deciding must not strand the
      // scene-change dialog: nothing else would resolve the pending promise or
      // close it. Resolving as "cancel" keeps their canvas untouched.
      canvasRef.current.cancelPendingCanvasDecision();
      handleRef.current = null;
      // The leave flush outlives this cleanup by design; React cannot await it.
      void handle?.destroy();
      // The canvas is no longer a room's scene: dropping the claim stops any
      // late callback from writing room state onto it.
      releaseCanvasRoom();
      dispatch({ type: "torn-down" });
    };
  }, [
    excalidrawAPI,
    roomId,
    roomKey,
    isAuthenticated,
    joinAttempt,
    wrapRemoteApply,
    wrapPresenceApply,
    suppressDirtyTracking,
    resumeDirtyTracking,
  ]);

  const retryJoin = useCallback(() => {
    setJoinAttempt((attempt) => attempt + 1);
  }, []);

  const onPointerUpdate = useCallback(
    (payload: ExcalidrawPointerUpdatePayload) => {
      handleRef.current?.handlePointerUpdate(payload);
    },
    [],
  );

  const onSceneChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
      handleRef.current?.handleSceneChange(elements, appState);
    },
    [],
  );

  // Derived, so neither fact overwrites the other: `status` is what the recovery
  // machine says about the connection, `syncBlock` is what the publish paths say
  // about the canvas, and only a session that is both connected and publishing
  // may present itself as syncing.
  //
  // The two are reported at different altitudes on purpose. The *status* defers to
  // the connection while one is being re-established — "重新連線中…" is both an
  // honest "not syncing" and the more immediately useful fact. The *message* does
  // not defer: the canvas being too large is true regardless of the socket, the
  // backoff window can run for minutes, and it is precisely the window in which
  // "get this work into a local file" matters most. Only a terminal failure's own
  // message outranks it, because that one tells the user the session is over.
  const isSyncBlocked = status === "connected" && syncBlock !== null;
  const visibleStatus: CollaborationRoomStatus = isSyncBlocked
    ? "sync-blocked"
    : status;
  const sizeWarning = syncBlock ? sceneSyncBlockMessage(syncBlock, t) : null;
  // Ranked last of the three, because it is the least urgent true thing: a
  // terminal failure ends the session, an oversize canvas risks losing the user's
  // own work, and this only says some of the room's images will not render.
  const assetWarning = assetsUnreadable
    ? t(UNREADABLE_ASSETS_MESSAGE_KEY)
    : null;

  return {
    status: visibleStatus,
    // Reported only while the status actually is a failure: the reason is a
    // property of the failed state, not a sticky flag, and a stale one would
    // keep the owner's destructive reset entry visible after a rejoin.
    failureReason: status === "failed" ? state.failureReason : null,
    role: state.role,
    // Still a collaboration session, and the canvas still belongs to the room: the
    // editor must keep withholding the actions that would replace it behind the
    // session's back. Only the *claim to be in sync* is withdrawn above.
    isCollaborating: status === "connected",
    // Keyed to the canvas claim, not to the connection: a viewer's canvas belongs
    // to the room for the whole session, so letting the editor become writable
    // during a reconnect window would accept edits the relay will refuse. And an
    // authorization the app has withdrawn is read-only whatever role this hook
    // still holds — see `roleWithdrawn`.
    isReadOnly:
      ownsCanvas &&
      (state.roleWithdrawn ||
        (state.role !== null && !roomRoleCanEditScene(state.role))),
    errorMessage: state.errorMessage ?? sizeWarning ?? assetWarning,
    ownsCanvas,
    retryJoin,
    onPointerUpdate,
    onSceneChange,
  };
}
