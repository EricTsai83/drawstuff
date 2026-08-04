import type { ClientId, RoomId } from "@drawstuff/collaboration/protocol";
import { createRelayWebSocketTransport } from "@drawstuff/collaboration/relay-client";
import type { ConnectionState } from "@drawstuff/collaboration/transport";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import {
  createCollaborationSession,
  type CollaborationSceneApi,
} from "@/lib/collab/collaboration-session";

/**
 * Runtime wiring for one authorized collaboration room: relay transport +
 * collaboration session + upstream-style idle detection. Everything it needs
 * to authorize the connection (room, client instance, join token) is supplied
 * by the caller, which obtained it from `collaborationRoom.join`; this module
 * never decides access and never sees the signing secret.
 */

/** Mirrors the upstream collab app's idle detection threshold. */
const IDLE_THRESHOLD_MS = 60_000;

export const COLLABORATION_ROOM_PARAM = "collab-room";
const MAX_USERNAME_LENGTH = 128;

export type CollaborationRoomHandle = {
  handleSceneChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ): void;
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
  getConnectionState(): ConnectionState;
  destroy(): void;
};

export function toCollaborationUsername(
  rawName: string | null | undefined,
  clientId: ClientId,
): string {
  return (
    rawName?.trim().slice(0, MAX_USERNAME_LENGTH) ||
    `guest-${clientId.slice(-4)}`
  );
}

export function startCollaborationRoomSession(options: {
  excalidrawApi: ExcalidrawImperativeAPI;
  relayUrl: string;
  roomId: RoomId;
  clientId: ClientId;
  /** Short-lived token from the app backend; the relay verifies it. */
  joinToken: string;
  username: string;
  wrapRemoteApply: (apply: () => void) => void;
  /**
   * Synchronous check that the canvas still holds this room's scene. Scene
   * loading replaces the canvas before React re-renders, so the session has to
   * consult a synchronous source of truth rather than a prop.
   */
  canSyncScene: () => boolean;
  onConnectionStateChange?: (state: ConnectionState) => void;
}): CollaborationRoomHandle {
  const sceneApi: CollaborationSceneApi = options.excalidrawApi;
  const transport = createRelayWebSocketTransport({ url: options.relayUrl });
  const unsubscribe = transport.subscribe({
    onConnectionStateChange: options.onConnectionStateChange,
  });
  const session = createCollaborationSession({
    transport,
    roomId: options.roomId,
    clientId: options.clientId,
    joinToken: options.joinToken,
    username: options.username,
    sceneApi,
    wrapRemoteApply: options.wrapRemoteApply,
    canSyncScene: options.canSyncScene,
  });

  // Upstream-style idle detection: pointer activity arms an idle timeout, tab
  // visibility flips between away and active.
  let idleTimerId: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    if (idleTimerId !== undefined) clearTimeout(idleTimerId);
    idleTimerId = setTimeout(() => {
      idleTimerId = undefined;
      session.setIdleState("idle");
    }, IDLE_THRESHOLD_MS);
  };
  const markActive = (): void => {
    session.setIdleState("active");
    armIdleTimer();
  };
  const handleVisibilityChange = (): void => {
    if (document.hidden) {
      if (idleTimerId !== undefined) clearTimeout(idleTimerId);
      idleTimerId = undefined;
      session.setIdleState("away");
      return;
    }
    markActive();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  session.connect();
  armIdleTimer();

  return {
    handleSceneChange: (elements, appState) => {
      session.handleLocalSceneChange(elements, appState);
    },
    handlePointerUpdate: (payload) => {
      markActive();
      session.handlePointerUpdate(payload);
    },
    getConnectionState: () => session.getConnectionState(),
    destroy() {
      if (idleTimerId !== undefined) clearTimeout(idleTimerId);
      idleTimerId = undefined;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribe();
      session.destroy();
      transport.close();
    },
  };
}
