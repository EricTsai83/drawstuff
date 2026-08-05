"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
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
import {
  canvasBelongsToRoom,
  claimCanvasForRoom,
  releaseCanvasRoom,
} from "@/lib/collab/canvas-room-marker";
import type { BaselineOutcome } from "@/lib/collab/collaboration-session";
import {
  startCollaborationRoomSession,
  toCollaborationUsername,
  type CollaborationRoomHandle,
} from "@/lib/collab/room-session";
import { api } from "@/trpc/react";

/**
 * Drives one collaboration room from the editor: prepares the canvas, exchanges
 * the room id for a short-lived join token, starts the relay session, and mirrors
 * the granted role as read-only editor state.
 *
 * The room id is a locator only — the backend decides the role, and a viewer's
 * session is read-only on the server whatever this hook reports. A dropped
 * connection is surfaced rather than silently retried: automatic reconnection is
 * Plan 18's scope, and a silent retry would hide a revoked membership.
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
 * unrelated scene loaded would push that scene's content into the room. Plan 13
 * avoided the leak by refusing such a join outright; this hook removes that
 * restriction the way the leak actually has to be closed — by making the canvas
 * the room's *before* the socket opens:
 *
 * 1. Unsaved local work is resolved through the editor's existing
 *    save/discard/cancel prompt. Cancelling means no connection is attempted.
 * 2. The canvas is emptied and the scene session cleared, which also drops the
 *    guest's `currentSceneId`. A guest must never adopt the owner's scene id —
 *    its own save would then try to overwrite somebody else's scene.
 * 3. The canvas is claimed for the room, and only then does the session connect
 *    and receive the room's baseline from an elected peer or from the durable
 *    snapshot.
 *
 * Because step 2 leaves the guest without a scene id, `canSyncScene` cannot be a
 * scene-id comparison any more; it is the canvas claim from step 3.
 */

export type CollaborationRoomStatus =
  | "idle"
  /** Resolving unsaved local work before the canvas is handed to the room. */
  | "preparing"
  | "joining"
  | "connected"
  | "disconnected"
  | "unauthorized"
  /** The user declined to give up the current canvas, so no join happened. */
  | "cancelled"
  /** The link carries a room id but no usable end-to-end key. */
  | "missing-room-key";

export type UseCollaborationRoomResult = {
  status: CollaborationRoomStatus;
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
  onPointerUpdate: (payload: ExcalidrawPointerUpdatePayload) => void;
  onSceneChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ) => void;
};

/** Reported to the user only when the outcome needs explaining. */
const BASELINE_MESSAGE: Partial<Record<BaselineOutcome, string>> = {
  "unreadable-snapshot":
    "這個 room 有已儲存的畫布，但無法用目前連結的金鑰解開。請向分享者索取最新的完整連結。",
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
  /** True when the canvas holds work that would be lost by joining. */
  hasLocalContent: () => boolean;
  /** The editor's existing three-way prompt for replacing the canvas. */
  requestSceneChangeDecision: () => Promise<"save" | "switch" | "cancel">;
  closeSceneChangeConfirm: () => void;
  /** Saves the current canvas to the cloud; false means the save failed. */
  uploadSceneToCloud: (opts?: {
    suppressSuccessToast?: boolean;
  }) => Promise<boolean>;
  /** Drops the local scene session (id, revision, dirty state). */
  clearCurrentScene: () => void;
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
  const { suppressDirtyTracking, resumeDirtyTracking } = useSceneSession();
  const utils = api.useUtils();

  const handleRef = useRef<CollaborationRoomHandle | null>(null);
  const [status, setStatus] = useState<CollaborationRoomStatus>("idle");
  const [role, setRole] = useState<RoomRole | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /**
   * True from the moment the canvas is claimed until the session is torn down.
   *
   * Distinct from `isCollaborating`, and that distinction is the point: the claim
   * is taken *before* the join token is minted and the key derived, so a status of
   * "connected" would leave a window in which the canvas already belongs to the
   * room while the editor still offers the actions that replace it.
   */
  const [ownsCanvas, setOwnsCanvas] = useState(false);

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
  usernameRef.current = username;
  const utilsRef = useRef(utils);
  utilsRef.current = utils;
  const canvasRef = useRef(options);
  canvasRef.current = options;

  /** Stable identity of this editor instance; the join token is bound to it. */
  const clientId = useMemo(
    () => clientIdSchema.parse(`client-${nanoid(16)}`),
    [],
  );

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
      setStatus("unauthorized");
      setErrorMessage("這個共編連結格式不正確。");
      return;
    }
    // Checked before any token is requested: without the key there is nothing a
    // session could do, and asking the backend for a token would only advertise
    // an attempt. The message never echoes the fragment.
    if (!roomKey) {
      setStatus("missing-room-key");
      setErrorMessage(
        "這個共編連結缺少加密金鑰（連結的 # 之後那一段）。請向分享者索取完整連結。",
      );
      return;
    }

    let cancelled = false;
    let handle: CollaborationRoomHandle | undefined;
    setStatus("joining");
    setErrorMessage(null);

    /**
     * Makes the on-screen canvas this room's scene before anything connects.
     * Returns false when the user declined, which is the only way to keep their
     * work: once the canvas is claimed the room's baseline replaces it.
     */
    const prepareCanvas = async (): Promise<boolean> => {
      const editor = canvasRef.current;
      if (editor.hasLocalContent()) {
        setStatus("preparing");
        const decision = await editor.requestSceneChangeDecision();
        if (cancelled) return false;
        if (decision === "cancel") {
          setStatus("cancelled");
          setErrorMessage(
            "已取消加入共編：目前畫布沒有變更，仍是你原本的場景。",
          );
          return false;
        }
        if (decision === "save") {
          const saved = await editor.uploadSceneToCloud({
            suppressSuccessToast: true,
          });
          if (cancelled) return false;
          if (!saved) {
            setStatus("cancelled");
            setErrorMessage("儲存目前場景失敗，因此沒有加入共編。請重試。");
            return false;
          }
        }
        editor.closeSceneChangeConfirm();
        setStatus("joining");
      }
      // Clearing the scene session drops this client's `currentSceneId`, so a
      // later save creates the guest's own scene instead of overwriting the
      // room owner's. It also releases any previous canvas claim, which is why
      // the new claim comes after it.
      suppressDirtyTracking();
      try {
        editor.clearCurrentScene();
        excalidrawAPI.updateScene({ elements: [] });
      } finally {
        requestAnimationFrame(() => {
          resumeDirtyTracking();
        });
      }
      return true;
    };

    const start = async (): Promise<void> => {
      try {
        // Which scene the room is for decides whether the canvas has to be
        // replaced at all: the owner already has it open.
        const room = await utilsRef.current.client.collaborationRoom.get.query({
          roomId: parsedRoomId.data,
        });
        if (cancelled) return;
        const isOpenScene = room.sceneId === canvasRef.current.currentSceneId;
        // The claim is deliberately *not* used to skip this. It is per tab, but
        // the restored canvas in localStorage is not: another tab that loaded an
        // unrelated scene leaves this tab's claim intact while replacing the
        // canvas it points at, so a reload would hand that unrelated scene to the
        // room. Asking again is the only answer that cannot be wrong.
        if (!isOpenScene && !(await prepareCanvas())) return;
        if (cancelled) return;
        // The claim is what `canSyncScene` reads, and it has to be in place
        // before the first inbound frame can be applied. It also puts the editor
        // into "this canvas is the room's" mode, which withholds the actions that
        // would replace the canvas behind the session's back.
        claimCanvasForRoom(parsedRoomId.data);
        setOwnsCanvas(true);

        // The token is fetched imperatively so it is minted immediately before
        // the socket opens: join tokens are short-lived by design.
        const joined =
          await utilsRef.current.client.collaborationRoom.join.mutate({
            roomId: parsedRoomId.data,
            clientId,
          });
        if (cancelled) return;
        // Key derivation is asynchronous, so the effect can be torn down while
        // the session is still being built. Whatever comes back has to be
        // destroyed in that case: the closure variable the cleanup reads is
        // still undefined at that point.
        const started = await startCollaborationRoomSession({
          excalidrawApi: excalidrawAPI,
          relayUrl: joined.relayUrl,
          roomId: joined.roomId,
          clientId,
          joinToken: joined.token,
          roomKey,
          authGeneration: joined.authGeneration,
          username: toCollaborationUsername(usernameRef.current, clientId),
          // Adapted rather than passed through: the store's contract is two
          // plain async functions, which keeps it testable without tRPC.
          snapshotApi: {
            get: (input) =>
              utilsRef.current.client.collaborationSnapshot.get.query(input),
            put: (input) =>
              utilsRef.current.client.collaborationSnapshot.put.mutate(input),
          },
          wrapRemoteApply,
          canSyncScene: () => canvasBelongsToRoom(joined.roomId),
          onBaselineResolved: (outcome) => {
            if (cancelled) return;
            const message = BASELINE_MESSAGE[outcome];
            if (message) setErrorMessage(message);
          },
          onConnectionStateChange: (state) => {
            if (cancelled) return;
            if (state.status === "connected") {
              setRole(state.role);
              setStatus("connected");
              return;
            }
            if (state.status === "connecting") return;
            // The relay closed us: revoked membership, an ended room, or a
            // transport failure. Report it instead of reconnecting silently.
            setStatus("disconnected");
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
        setStatus("unauthorized");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "無法加入共編 room，請確認你仍有存取權限。",
        );
      }
    };
    void start();

    return () => {
      cancelled = true;
      handleRef.current = null;
      // The leave flush outlives this cleanup by design; React cannot await it.
      void handle?.destroy();
      // The canvas is no longer a room's scene: dropping the claim stops any
      // late callback from writing room state onto it.
      releaseCanvasRoom();
      setOwnsCanvas(false);
      setStatus("idle");
      setRole(null);
      setErrorMessage(null);
    };
  }, [
    excalidrawAPI,
    roomId,
    roomKey,
    isAuthenticated,
    clientId,
    wrapRemoteApply,
    suppressDirtyTracking,
    resumeDirtyTracking,
  ]);

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

  return {
    status,
    role,
    isCollaborating: status === "connected",
    isReadOnly:
      status === "connected" && role !== null && !roomRoleCanEditScene(role),
    errorMessage,
    ownsCanvas,
    onPointerUpdate,
    onSceneChange,
  };
}
