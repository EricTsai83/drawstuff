import type { ClientId, RoomId } from "@drawstuff/collaboration/protocol";
import {
  createRealtimeCryptoCodec,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
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
  type BaselineOutcome,
  type CollaborationSceneApi,
} from "@/lib/collab/collaboration-session";
import {
  createCollaborationSnapshotStore,
  type SnapshotApi,
} from "@/lib/collab/snapshot-store";

/**
 * Runtime wiring for one authorized collaboration room: realtime crypto codec +
 * relay transport + collaboration session + upstream-style idle detection.
 * Everything it needs to authorize the connection (room, client instance, join
 * token) is supplied by the caller, which obtained it from
 * `collaborationRoom.join`; this module never decides access and never sees the
 * signing secret.
 *
 * The room key is the other half, and it comes from the other direction: the
 * caller reads it from the URL fragment, never from the backend. That split is
 * what makes the relay unable to read the room — it verifies tokens it cannot
 * turn into a decryption key.
 *
 * The durable snapshot store is wired up here for the same reason the transport
 * is: it needs both halves. The same room key stretches into a second,
 * purpose-bound key, so the app backend stores a baseline it cannot read either.
 */

/** Mirrors the upstream collab app's idle detection threshold. */
const IDLE_THRESHOLD_MS = 60_000;

const MAX_USERNAME_LENGTH = 128;

export type CollaborationRoomHandle = {
  handleSceneChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ): void;
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
  getConnectionState(): ConnectionState;
  /**
   * Tears the session down. Returns the leave flush so a caller that can wait
   * (a test, a future explicit "leave room" action) may; React's synchronous
   * cleanup simply ignores it and the flush completes on its own.
   */
  destroy(): Promise<void>;
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

export async function startCollaborationRoomSession(options: {
  excalidrawApi: ExcalidrawImperativeAPI;
  relayUrl: string;
  roomId: RoomId;
  clientId: ClientId;
  /** Short-lived token from the app backend; the relay verifies it. */
  joinToken: string;
  /** End-to-end room key from the URL fragment; never from the backend. */
  roomKey: RoomKey;
  /**
   * The room's durable authorization generation, from `collaborationRoom.join`.
   * Key derivation is bound to it, so rotating the generation makes the previous
   * generation's ciphertext unreadable.
   */
  authGeneration: number;
  username: string;
  /** Backend surface for the durable snapshot; the tRPC client satisfies it. */
  snapshotApi: SnapshotApi;
  wrapRemoteApply: (apply: () => void) => void;
  /**
   * Synchronous check that the canvas still holds this room's scene. Scene
   * loading replaces the canvas before React re-renders, so the session has to
   * consult a synchronous source of truth rather than a prop.
   */
  canSyncScene: () => boolean;
  onConnectionStateChange?: (state: ConnectionState) => void;
  /** Reported once per connection when the join baseline resolves. */
  onBaselineResolved?: (outcome: BaselineOutcome) => void;
}): Promise<CollaborationRoomHandle> {
  const sceneApi: CollaborationSceneApi = options.excalidrawApi;
  const transport = createRelayWebSocketTransport({
    url: options.relayUrl,
    crypto: await createRealtimeCryptoCodec({
      roomKey: options.roomKey,
      roomId: options.roomId,
      authGeneration: options.authGeneration,
    }),
  });
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
    snapshotStore: await createCollaborationSnapshotStore({
      api: options.snapshotApi,
      roomId: options.roomId,
      roomKey: options.roomKey,
      authGeneration: options.authGeneration,
    }),
    wrapRemoteApply: options.wrapRemoteApply,
    canSyncScene: options.canSyncScene,
    onBaselineResolved: options.onBaselineResolved,
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
      // Leaving may be the room emptying out, and an empty room has no live copy
      // of the scene left — so the durable snapshot has to be brought current
      // here. The flush deliberately outlives `destroy()`: it is a forced write,
      // which is exempt from the teardown guard precisely because the digest it
      // has to compute is asynchronous and every teardown would otherwise abort
      // it in the same tick. It cannot be awaited (React cleanup is synchronous),
      // so the promise is returned for callers that can.
      const flushed = session.flushSnapshot();
      unsubscribe();
      session.destroy();
      transport.close();
      return flushed;
    },
  };
}
