"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";
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

import { useSceneSession } from "@/hooks/scene-session-context";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { createAuthorityAssetApi } from "@/lib/collab/asset-upload";
import { createBinarySnapshotClient } from "@/lib/collab/snapshot-http";
import {
  createAuthorityRoomBackend,
  type AuthorityApi,
} from "@/lib/collab/authority-client";
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
import {
  clearPersonalDraft,
  restorePersonalDraft,
} from "@/lib/collab/personal-draft";
import { resumeLocalScenePersistence } from "@/data/local-scene-persistence";
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
 * without saying anything: lost access and an ended room both end a session for
 * good, and each of them looks exactly like a
 * network blip until the reason is reported. So the user-facing status follows the
 * session's *recovery* state rather than its socket state — `reconnecting` and
 * `failed` are both a closed socket, and only one of them is worth waiting for.
 *
 * An account the room refuses ends in `failed` with reason `no-access`, both
 * on the first join and when access is withdrawn mid-session.
 *
 * ## Canvas ownership
 * Authorization precedes the handoff. The personal draft
 * and its identity/revision are preserved per tab; all local canvas writers
 * pause synchronously before room state can be applied. Room links reload from
 * the stored baseline, and teardown restores the personal draft before
 * releasing the persistence hold. Personal copies never attach to room edits.
 */
import type { RoomSaveState } from "@/lib/collab/session/save-state";

export type UseCollaborationRoomResult = {
  saveState: RoomSaveState;
  sourceSceneId: string | null;
  requestSave: () => void;
  confirmExit: () => boolean;
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
   * for the states an action can genuinely repair, where "reload the page"
   * was previously the only way to re-run the join.
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
  /** Cloud scene id currently open in the editor, if any. */
  currentSceneId: string | null;
  /** Display name for presence; falls back to a per-client guest label. */
  username: string | null | undefined;
  /** Collaboration requires an authenticated session. */
  isAuthenticated: boolean;
  /**
   * Makes the on-screen canvas this room's scene before anything connects:
   * unsaved work is resolved through the editor's prompt, then the personal
   * draft is preserved and the room claims an isolated canvas. See `useCanvasHandoff`, which owns the
   * whole sequence — this hook only consumes the outcome.
   */
  prepareCanvasForRoom: (params: {
    isCancelled: () => boolean;
    keepCanvas?: boolean;
    skipPrompt?: boolean;
    onDecisionPrompt: () => void;
  }) => Promise<CanvasHandoffOutcome>;
  /**
   * Settles a still-open canvas prompt as "cancel" and closes it. The join
   * effect's cleanup calls this — a teardown mid-decision otherwise leaves the
   * dialog open forever, with nobody awaiting the answer.
   */
  cancelPendingCanvasDecision: () => void;
}): UseCollaborationRoomResult {
  const { excalidrawAPI, roomId, username, isAuthenticated } = options;
  const { t } = useAppI18n();
  const tRef = useRef(t);
  const { suppressDirtyTracking, resumeDirtyTracking, reloadSceneSession } =
    useSceneSession();
  const utils = api.useUtils();

  const handleRef = useRef<CollaborationRoomHandle | null>(null);
  /**
   * Re-running the join is a state change, not a callback: the join lives in
   * an effect, so the retry bumps a counter the effect depends on, which tears
   * the failed attempt down through the normal cleanup and starts over.
   */
  const [saveState, setSaveState] = useState<RoomSaveState>({
    status: "idle",
    revision: null,
    checksum: null,
  });
  const [sourceSceneId, setSourceSceneId] = useState<string | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [state, dispatch] = useReducer(roomStateReducer, initialRoomState);
  const { status, syncBlock, assetsUnreadable, ownsCanvas } = state;

  /**
   * Read at connect time instead of being effect dependencies: a display name
   * that arrives with the auth session, a new tRPC utils identity, or a
   * re-created editor callback must not tear down and rejoin a live room.
   *
   * `currentSceneId` selects the source once at entry. Later personal uploads or
   * metadata updates must not restart a live room; ownership is the tab claim.
   */
  const usernameRef = useRef(username);
  const utilsRef = useRef(utils);
  const canvasRef = useRef(options);
  // Synchronized after commit rather than assigned in the render body: a
  // concurrent render that is thrown away must not leave its uncommitted
  // values behind in the refs. Declared before the join effect so the refs are
  // current by the time it runs.
  useLayoutEffect(() => {
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

    // The sequence itself lives in `collaboration-room-controller.ts`; this
    // effect only binds it to React: refs are read through getters so their
    // latest committed value is used at call time, and the reducer receives
    // every transition.
    const authority: AuthorityApi = {
      execute: (input) =>
        utilsRef.current.client.collaborationAuthority.execute.mutate(input),
      identity: (input: { roomId: string }) =>
        utilsRef.current.client.collaborationAuthority.identity.mutate(input),
    };
    const controller = createCollaborationRoomController({
      excalidrawApi: excalidrawAPI,
      roomId: parsedRoomId.data,
      backend: {
        ...createAuthorityRoomBackend(authority),
        // The store's binary transport retains opaque original operations.
        snapshotApi: createBinarySnapshotClient(),
        // Same shape, and for the same reason: the store needs two plain async
        // functions, one to find out where a room's asset lives and one to put
        // it there.
        assetApi: createAuthorityAssetApi({
          authority,
          execute: (input, signal) =>
            utilsRef.current.client.collaborationAsset.execute.mutate(input, {
              signal,
            }),
          resolve: (input, signal) =>
            utilsRef.current.client.collaborationAsset.resolve.query(input, {
              signal,
            }),
        }),
      },
      dispatch,
      onSaveStateChange: setSaveState,
      onSourceScene: setSourceSceneId,
      getTranslate: () => tRef.current,
      getUsername: () => usernameRef.current,
      getCurrentSceneId: () => canvasRef.current.currentSceneId,
      prepareCanvasForRoom: (params) =>
        canvasRef.current.prepareCanvasForRoom(params),
      cancelPendingCanvasDecision: () =>
        canvasRef.current.cancelPendingCanvasDecision(),
      restorePersonalCanvas: () => {
        wrapRemoteApply(() => {
          if (!canvasRef.current.isAuthenticated) {
            clearPersonalDraft();
            excalidrawAPI.resetScene();
            resumeLocalScenePersistence("collaboration-canvas");
            reloadSceneSession();
            return;
          }
          if (restorePersonalDraft(excalidrawAPI)) reloadSceneSession();
        });
      },
      wrapRemoteApply,
      wrapPresenceApply,
      onHandleChange: (handle) => {
        handleRef.current = handle;
        if (!handle) {
          setSourceSceneId(null);
          setSaveState({ status: "idle", revision: null, checksum: null });
        }
      },
    });
    void controller.start();
    return controller.stop;
  }, [
    excalidrawAPI,
    roomId,
    isAuthenticated,
    joinAttempt,
    reloadSceneSession,
    wrapRemoteApply,
    wrapPresenceApply,
    suppressDirtyTracking,
    resumeDirtyTracking,
  ]);

  useEffect(() => {
    if (roomId || !excalidrawAPI) return;
    wrapRemoteApply(() => {
      if (restorePersonalDraft(excalidrawAPI)) reloadSceneSession();
    });
  }, [roomId, excalidrawAPI, reloadSceneSession, wrapRemoteApply]);

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

  const requestSave = useCallback(() => handleRef.current?.requestSave(), []);
  const confirmExit = useCallback(
    () =>
      !handleRef.current ||
      handleRef.current.getSaveState().status === "saved" ||
      window.confirm(tRef.current("storage.leaveRisk")),
    [],
  );
  // Consult the live session for a change in the same tick as beforeunload.
  useEffect(() => {
    if (!roomId) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (
        !handleRef.current ||
        handleRef.current.getSaveState().status === "saved"
      )
        return;
      event.preventDefault();
      Reflect.set(event, "returnValue", "");
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [roomId]);

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
    saveState,
    sourceSceneId,
    requestSave,
    confirmExit,
    status: visibleStatus,
    // Reported only while the status actually is a failure: the reason is a
    // property of the failed state, not a sticky flag.
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
      (!!roomId &&
        (!ownsCanvas || status === "joining" || status === "failed")) ||
      (ownsCanvas &&
        (state.roleWithdrawn ||
          (state.role !== null && !roomRoleCanEditScene(state.role)))),
    errorMessage: state.errorMessage ?? sizeWarning ?? assetWarning,
    ownsCanvas,
    retryJoin,
    onPointerUpdate,
    onSceneChange,
    onScrollChange,
  };
}
