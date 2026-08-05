"use client";

import { TRPCClientError } from "@trpc/client";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { UnrecoverableReason } from "@drawstuff/collaboration/recovery";
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
import { uploadCollaborationAsset } from "@/lib/collab/asset-upload";
import type { JoinCredentialsResult } from "@/lib/collab/collaboration-session";
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
 * session is read-only on the server whatever this hook reports.
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
  /** The connection dropped and the session is retrying with backoff. */
  | "reconnecting"
  /** Recovery stopped for a stated reason; `errorMessage` carries it. */
  | "failed"
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

/**
 * What each terminal recovery reason means for the user, and what they can do
 * about it. Every reason gets a message: an unexplained "stopped reconnecting" is
 * indistinguishable from a hang, and the action differs per reason — ask for
 * access, ask for a new link, or reload.
 *
 * None of them echoes the room key or the fragment.
 */
const FAILURE_MESSAGE: Record<UnrecoverableReason, string> = {
  unauthorized:
    "目前無法取得這個共編 room 的存取權，連線已停止。請確認你仍是成員，或向擁有者重新索取邀請。",
  "membership-revoked": "你的共編權限已被移除，連線已結束。",
  "room-ended":
    "這個共編 room 已被擁有者結束或重設，連線已停止。請向分享者索取新的連結。",
  "generation-rotated":
    "這個 room 的加密世代已更新，目前的連結無法再解密內容。請向分享者索取新的完整連結。",
  "unreadable-room":
    "這個 room 有已儲存的畫布，但無法用目前連結的金鑰解開。請向分享者索取最新的完整連結。",
  "protocol-violation":
    "連線因通訊協定錯誤而中止。請重新載入頁面；若持續發生請回報。",
  "crypto-exhausted":
    "這個連線的加密額度已用盡，無法繼續安全傳送。請由擁有者重設 room generation 後重新加入。",
  "retry-limit":
    "多次重新連線都失敗，已停止重試。請確認網路連線後重新載入頁面。",
};

/**
 * Turns a failed `collaborationRoom.join` into the credential refusal recovery
 * acts on.
 *
 * This is the only place that can make the call. The relay closes a socket as soon
 * as the app withdraws the authorization it holds, and it uses one close code for
 * both "removed from the room" and "role changed" — and a role change *must*
 * reconnect, because the role travels in the token. So the relay's close is always
 * retried, and this request is where a client that genuinely cannot come back is
 * stopped.
 *
 * Read off the tRPC error code rather than the message, and deliberately
 * conservative: only the codes that state a refusal are terminal, so an
 * unrecognized failure is retried. A retried refusal costs one round-trip and
 * lands here again; a terminal verdict on a transient failure would abandon a
 * session that was coming back.
 *
 * `PRECONDITION_FAILED` is `accessError`'s answer for a room that has ended or
 * expired, which is exactly why it must not read as "unavailable": retrying it
 * would spend the whole budget and then report the wrong reason.
 */
function classifyJoinFailure(error: unknown): JoinCredentialsResult {
  const code =
    error instanceof TRPCClientError
      ? (error.data as { code?: unknown } | null | undefined)?.code
      : undefined;
  switch (code) {
    case "FORBIDDEN":
      return { ok: false, retry: false, failure: "membership-revoked" };
    case "UNAUTHORIZED":
      return { ok: false, retry: false, failure: "unauthorized" };
    case "PRECONDITION_FAILED":
    case "NOT_FOUND":
      return { ok: false, retry: false, failure: "room-ended" };
    default:
      return { ok: false, retry: true };
  }
}

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
   * True once the app has withdrawn this connection's authorization and a new
   * grant has not arrived yet.
   *
   * The relay closes with `membership-revoked` both when a member is removed and
   * when their *role* is changed — a role change has to force a reconnect, because
   * the role travels in the token. So during that reconnect the role this hook is
   * holding may no longer be the user's, and continuing to accept edits on the
   * strength of it is how a demoted editor produces work the reconnected viewer can
   * never publish: locally newer than the room, refused by the relay, permanently
   * divergent. A transient drop is different — the role is unchanged, so editing
   * continues and the offline queue carries it.
   */
  const [roleWithdrawn, setRoleWithdrawn] = useState(false);

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
    /** Separates the first join from every reconnect after it. */
    let hasBeenLive = false;
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
                clientId,
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
          clientId,
          joinToken: joined.token,
          refreshJoinToken,
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
          canSyncScene: () => canvasBelongsToRoom(joined.roomId),
          // Role only: the granted role is a property of the socket, and it must
          // survive a reconnect window so a viewer's editor does not briefly
          // become writable while the session is retrying.
          onConnectionStateChange: (state) => {
            if (cancelled) return;
            if (state.status === "connected") {
              setRole(state.role);
              // The server just stated the role, so it is authoritative again.
              setRoleWithdrawn(false);
              return;
            }
            if (
              state.status === "disconnected" &&
              state.reason === "membership-revoked"
            ) {
              setRoleWithdrawn(true);
            }
          },
          onRecoveryStateChange: (state) => {
            if (cancelled) return;
            if (state.phase === "failed") {
              setStatus("failed");
              setErrorMessage(FAILURE_MESSAGE[state.reason]);
              return;
            }
            setErrorMessage(null);
            if (state.phase === "live") {
              hasBeenLive = true;
              setStatus("connected");
              return;
            }
            if (state.phase === "idle") {
              setStatus("idle");
              return;
            }
            // Before the first successful join this is still the join; after it,
            // it is a reconnect. The difference is the whole point of the status:
            // "this is slow" versus "this broke and is coming back".
            setStatus(hasBeenLive ? "reconnecting" : "joining");
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
      setRoleWithdrawn(false);
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
    // Keyed to the canvas claim, not to the connection: a viewer's canvas belongs
    // to the room for the whole session, so letting the editor become writable
    // during a reconnect window would accept edits the relay will refuse. And an
    // authorization the app has withdrawn is read-only whatever role this hook
    // still holds — see `roleWithdrawn`.
    isReadOnly:
      ownsCanvas &&
      (roleWithdrawn || (role !== null && !roomRoleCanEditScene(role))),
    errorMessage,
    ownsCanvas,
    onPointerUpdate,
    onSceneChange,
  };
}
