"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

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
import { uploadCollaborationAsset } from "@/lib/collab/asset-upload";
import { createCollaborationRoomController } from "@/hooks/excalidraw/collaboration-room-controller";
import type { CanvasHandoffOutcome } from "@/hooks/excalidraw/use-canvas-handoff";
import {
  sceneSyncBlockMessage,
  UNREADABLE_ASSETS_MESSAGE_KEY,
} from "@/lib/collab/collaboration-messages";
import {
  initialRoomState,
  roomStateReducer,
  type CollaborationFailureReason,
  type CollaborationRoomStatus,
} from "@/lib/collab/room-state-reducer";
import type { CollaborationRoomHandle } from "@/lib/collab/room-session";
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
 * state machine in `lib/collab/room-state-reducer.ts`. The join sequence itself
 * — canvas preparation, the join exchange, session wiring and teardown — is
 * `collaboration-room-controller.ts`; this hook owns the effect that runs it
 * and the React state it reports into.
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
  /** Wire to the editor `onScrollChange`: peers following this client move
   *  with its viewport. (Following *someone else* needs no editor wiring —
   *  the room session subscribes to the engine's follow events directly.) */
  onScrollChange: () => void;
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

    // The sequence itself lives in `collaboration-room-controller.ts`; this
    // effect only binds it to React: refs are read through getters so their
    // latest committed value is used at call time, and the reducer receives
    // every transition.
    const controller = createCollaborationRoomController({
      excalidrawApi: excalidrawAPI,
      roomId: parsedRoomId.data,
      roomKey,
      backend: {
        getRoom: (input) =>
          utilsRef.current.client.collaborationRoom.get.query(input),
        joinRoom: (input) =>
          utilsRef.current.client.collaborationRoom.join.mutate(input),
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
      },
      dispatch,
      getTranslate: () => tRef.current,
      getUsername: () => usernameRef.current,
      getCurrentSceneId: () => canvasRef.current.currentSceneId,
      prepareCanvasForRoom: (params) =>
        canvasRef.current.prepareCanvasForRoom(params),
      cancelPendingCanvasDecision: () =>
        canvasRef.current.cancelPendingCanvasDecision(),
      wrapRemoteApply,
      wrapPresenceApply,
      onHandleChange: (handle) => {
        handleRef.current = handle;
      },
    });
    void controller.start();
    return controller.stop;
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

  const onScrollChange = useCallback(() => {
    handleRef.current?.handleScrollChange();
  }, []);

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
    onScrollChange,
  };
}
