"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
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

import { loadCurrentSceneIdFromStorage } from "@/data/local-storage";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  startCollaborationRoomSession,
  toCollaborationUsername,
  type CollaborationRoomHandle,
} from "@/lib/collab/room-session";
import { api } from "@/trpc/react";

/**
 * Drives one collaboration room from the editor: exchanges the room id for a
 * short-lived join token, starts the relay session, and mirrors the granted
 * role as read-only editor state.
 *
 * The room id is a locator only — the backend decides the role, and a viewer's
 * session is read-only on the server whatever this hook reports. A dropped
 * connection is surfaced rather than silently retried: automatic reconnection
 * is Plan 18's scope, and a silent retry would hide a revoked membership.
 *
 * The room's scene must already be the open scene. A session broadcasts the
 * local canvas as soon as it connects, so joining with a different scene loaded
 * would publish unrelated content into the room; that is refused here rather
 * than mitigated afterwards. Loading a room's scene for someone who does not
 * have it is Plan 15's durable-snapshot work.
 */

export type CollaborationRoomStatus =
  | "idle"
  | "joining"
  | "connected"
  | "disconnected"
  | "unauthorized"
  /** The room belongs to a scene other than the one currently open. */
  | "scene-mismatch";

export type UseCollaborationRoomResult = {
  status: CollaborationRoomStatus;
  role: RoomRole | null;
  isCollaborating: boolean;
  /** True while connected as a viewer: the editor renders in view mode. */
  isReadOnly: boolean;
  errorMessage: string | null;
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
  /** Cloud scene id currently open in the editor, if any. */
  currentSceneId: string | null;
  /** Display name for presence; falls back to a per-client guest label. */
  username: string | null | undefined;
  /** Collaboration requires an authenticated session. */
  isAuthenticated: boolean;
}): UseCollaborationRoomResult {
  const { excalidrawAPI, roomId, currentSceneId, username, isAuthenticated } =
    options;
  const { suppressDirtyTracking, resumeDirtyTracking } = useSceneSession();
  const utils = api.useUtils();

  const handleRef = useRef<CollaborationRoomHandle | null>(null);
  const [status, setStatus] = useState<CollaborationRoomStatus>("idle");
  const [role, setRole] = useState<RoomRole | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Read at connect time instead of being effect dependencies: a display name
   * that arrives with the auth session, or a new tRPC utils identity, must not
   * tear down and rejoin a live room.
   */
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const utilsRef = useRef(utils);
  utilsRef.current = utils;

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

  useEffect(() => {
    if (!excalidrawAPI || !roomId || !isAuthenticated) return;
    const parsedRoomId = roomIdSchema.safeParse(roomId);
    if (!parsedRoomId.success) {
      setStatus("unauthorized");
      setErrorMessage("這個共編連結格式不正確。");
      return;
    }

    let cancelled = false;
    let handle: CollaborationRoomHandle | undefined;
    setStatus("joining");
    setErrorMessage(null);

    const start = async (): Promise<void> => {
      try {
        // Establish which scene the room is for before asking for a token, so
        // a mismatch never mints one and never opens a socket.
        const room = await utilsRef.current.client.collaborationRoom.get.query({
          roomId: parsedRoomId.data,
        });
        if (cancelled) return;
        if (room.sceneId !== currentSceneId) {
          setStatus("scene-mismatch");
          setErrorMessage(
            "這個共編 room 屬於另一個場景。請先開啟該場景，再從共編面板加入。",
          );
          return;
        }
        // The token is fetched imperatively so it is minted immediately before
        // the socket opens: join tokens are short-lived by design.
        const joined =
          await utilsRef.current.client.collaborationRoom.join.mutate({
            roomId: parsedRoomId.data,
            clientId,
          });
        if (cancelled) return;
        handle = startCollaborationRoomSession({
          excalidrawApi: excalidrawAPI,
          relayUrl: joined.relayUrl,
          roomId: joined.roomId,
          clientId,
          joinToken: joined.token,
          username: toCollaborationUsername(usernameRef.current, clientId),
          wrapRemoteApply,
          // Scene loading replaces the canvas and writes the new scene id to
          // storage in the same synchronous block, then updates React state.
          // Reading storage therefore closes the window a prop comparison
          // would leave open between the swap and this effect's cleanup.
          canSyncScene: () =>
            loadCurrentSceneIdFromStorage() === joined.sceneId,
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
      handle?.destroy();
      setStatus("idle");
      setRole(null);
      setErrorMessage(null);
    };
  }, [
    excalidrawAPI,
    roomId,
    currentSceneId,
    isAuthenticated,
    clientId,
    wrapRemoteApply,
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
    onPointerUpdate,
    onSceneChange,
  };
}
