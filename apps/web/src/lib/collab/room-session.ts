import {
  peerIdSchema,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import {
  createRealtimeCryptoCodec,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
import type { RecoveryState } from "@drawstuff/collaboration/recovery";
import { createRelayWebSocketTransport } from "@drawstuff/collaboration/relay-client";
import type { ConnectionState } from "@drawstuff/collaboration/transport";
import {
  getVisibleSceneBounds,
  zoomToFitBounds,
} from "@drawstuff/excalidraw-adapter/client";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawPointerUpdatePayload,
  OnUserFollowedPayload,
  OrderedExcalidrawElement,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import {
  createCollaborationAssetStore,
  type AssetApi,
  type CollaborationAssetStore,
} from "@/lib/collab/asset-store";
import {
  createCollaborationSession,
  type CollaborationSceneApi,
  type CollaborationSession,
  type FollowHost,
  type JoinCredentialsResult,
  type PresenceViewBounds,
  type SceneSyncBlock,
} from "@/lib/collab/collaboration-session";
import {
  createCollaborationSnapshotStore,
  type CollaborationSnapshotStore,
  type SnapshotApi,
} from "@/lib/collab/snapshot-store";

/**
 * Runtime wiring for one authorized collaboration room: realtime crypto codec +
 * relay transport + collaboration session + upstream-style idle detection.
 * Everything it needs to authorize the connection (room, join token) is
 * supplied by the caller, which obtained it from `collaborationRoom.join`;
 * this module never decides access and never sees the signing secret.
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
  /** Wire to the editor `onScrollChange`: relays the local visible scene
   *  bounds so peers following this client move with it. */
  handleScrollChange(): void;
  getConnectionState(): ConnectionState;
  /**
   * Tears the session down. Returns the leave flush so a caller that can wait
   * (a test, a future explicit "leave room" action) may; React's synchronous
   * cleanup simply ignores it and the flush completes on its own.
   */
  destroy(): Promise<void>;
};

/**
 * Trims and bounds the display name. Returns "" for an unnamed user: the
 * session substitutes `guest-<peerId suffix>` per connection, because the
 * relay-assigned peer id does not exist before the join completes.
 */
export function toCollaborationUsername(
  rawName: string | null | undefined,
): string {
  return rawName?.trim().slice(0, MAX_USERNAME_LENGTH) ?? "";
}

export async function startCollaborationRoomSession(options: {
  excalidrawApi: ExcalidrawImperativeAPI;
  relayUrl: string;
  roomId: RoomId;
  /** Short-lived token from the app backend; the relay verifies it. */
  joinToken: string;
  /**
   * Mints a token for a reconnect attempt. Separate from `joinToken` because the
   * first token was already minted by the caller (it is how the caller learned
   * `relayUrl` and `authGeneration`), and because a reconnect needs a *fresh*
   * one: tokens are short-lived, and re-asking the backend is what makes a
   * membership revoked while offline fail at authorization rather than loop
   * against the relay.
   */
  refreshJoinToken: () => Promise<JoinCredentialsResult>;
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
  /**
   * Backend surface for encrypted assets: the tRPC client resolves where
   * ciphertext lives, the upload route stores it. Both halves are authorization
   * only — neither can read what they carry.
   */
  assetApi: AssetApi;
  wrapRemoteApply: (apply: () => void) => void;
  /**
   * Wrapper for presence-only canvas writes (collaborator cursors). Kept
   * separate from `wrapRemoteApply` so the host can release its dirty-tracking
   * suppression synchronously for writes that carry no scene state; see
   * `CollaborationSessionOptions.wrapPresenceApply`.
   */
  wrapPresenceApply?: (apply: () => void) => void;
  /**
   * Synchronous check that the canvas still holds this room's scene. Scene
   * loading replaces the canvas before React re-renders, so the session has to
   * consult a synchronous source of truth rather than a prop.
   */
  canSyncScene: () => boolean;
  onConnectionStateChange?: (state: ConnectionState) => void;
  /**
   * Reported on every recovery phase change. This — not the socket state — is
   * what a user-facing status has to follow: "waiting to reconnect" and "this
   * room is gone" are both `disconnected` sockets.
   */
  onRecoveryStateChange?: (state: RecoveryState) => void;
  /**
   * Reported when the canvas grows past a locked size contract and a publish path
   * stops carrying it, and `null` once it fits again. Separate from the recovery
   * state because it is not a connection condition: the socket is fine and the
   * room is reachable, but this client's own scene can no longer be published, so
   * a UI that only follows recovery would keep claiming everything is in sync.
   */
  onSceneSyncBlockChange?: (block: SceneSyncBlock | null) => void;
  /**
   * Reported once when the room turns out to hold images this link cannot open
   * and none has ever opened. Separate from the recovery state on purpose: unlike
   * an unreadable *scene*, unreadable images are not terminal — the elements
   * still sync and the session is genuinely healthy — so this is a fact about the
   * canvas's completeness, not about the connection.
   */
  onAssetsUnreadable?: () => void;
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

  // Late-bound on purpose: the store hands opened assets to the session, and the
  // session needs the store to ask for them. A download settles long after the
  // element that referenced it was applied, so the dependency has to run in that
  // direction — the alternative is the session polling for bytes that may never
  // arrive.
  let assetTarget: CollaborationSession | undefined;
  let assetStore: CollaborationAssetStore | undefined;
  let snapshotStore: CollaborationSnapshotStore;
  try {
    assetStore = await createCollaborationAssetStore({
      api: options.assetApi,
      roomId: options.roomId,
      roomKey: options.roomKey,
      authGeneration: options.authGeneration,
      onAssetsResolved: (files) => {
        assetTarget?.applyRemoteAssets(files);
      },
      onAssetsUnreadable: options.onAssetsUnreadable,
      onAssetsUnavailable: (fileIds) => {
        assetTarget?.applyUnavailableAssets(fileIds);
      },
      onPublishRetryDue: () => {
        assetTarget?.republishLocalAssets();
      },
    });
    snapshotStore = await createCollaborationSnapshotStore({
      api: options.snapshotApi,
      roomId: options.roomId,
      roomKey: options.roomKey,
      authGeneration: options.authGeneration,
    });
  } catch (error) {
    // Key derivation for either store can reject after the transport already
    // exists. The caller's catch only releases the canvas claim, so what was
    // built here has to be released here — otherwise the subscription, the
    // asset store's abort controller and the socket all outlive the failed join.
    unsubscribe();
    assetStore?.destroy();
    transport.close();
    throw error;
  }

  /**
   * Engine half of follow mode. Fitting (rather than copying scroll/zoom
   * verbatim) is what makes following work across different window sizes —
   * the same behaviour as upstream's collab app, via the same public helpers.
   */
  const followHost: FollowHost = {
    applyViewportBounds: (bounds: PresenceViewBounds) => {
      const appState = options.excalidrawApi.getAppState();
      const fitted = zoomToFitBounds({
        bounds,
        appState,
        fitToViewport: true,
        viewportZoomFactor: 1,
      }).appState;
      // Compare the fit against the live viewport instead of deduping on the
      // incoming bounds: a local resize or manual pan changes what unchanged
      // bounds fit to, and the followed peer's steady pointer stream must be
      // able to correct it — while a static, already-fitting viewport takes
      // no canvas write at all.
      if (
        fitted.scrollX === appState.scrollX &&
        fitted.scrollY === appState.scrollY &&
        fitted.zoom.value === appState.zoom.value
      ) {
        return;
      }
      options.excalidrawApi.updateScene({
        appState: {
          scrollX: fitted.scrollX,
          scrollY: fitted.scrollY,
          zoom: fitted.zoom,
        },
      });
    },
    clearFollowTarget: () => {
      options.excalidrawApi.updateScene({ appState: { userToFollow: null } });
    },
    applyFollowedBy: (peerIds) => {
      options.excalidrawApi.updateScene({
        appState: { followedBy: new Set(peerIds as unknown as SocketId[]) },
      });
    },
  };

  const session = createCollaborationSession({
    transport,
    roomId: options.roomId,
    joinToken: options.joinToken,
    authGeneration: options.authGeneration,
    refreshJoinToken: options.refreshJoinToken,
    username: options.username,
    sceneApi,
    snapshotStore,
    assetStore,
    wrapRemoteApply: options.wrapRemoteApply,
    wrapPresenceApply: options.wrapPresenceApply,
    followHost,
    canSyncScene: options.canSyncScene,
    onSceneSyncBlockChange: options.onSceneSyncBlockChange,
    onRecoveryStateChange: (state) => {
      // A terminal recovery state ends this room's work, and the session can only
      // release what it owns. Everything wired up *around* it — the encrypted asset
      // transfers, their retry timer, the idle timer, the visibility listener, the
      // socket itself — is owned here, and the React effect that owns this handle
      // stays mounted while the failure is displayed. So the teardown runs here
      // too, or a stopped session keeps fetching assets and firing timers for a
      // room it can no longer reach.
      if (state.phase === "failed") releaseRoomResources();
      options.onRecoveryStateChange?.(state);
    },
  });
  assetTarget = session;

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

  /**
   * Releases everything this module owns. Idempotent, because it runs both on a
   * terminal recovery state and on `destroy()`, and either can come first.
   */
  let released = false;
  function releaseRoomResources(): void {
    if (released) return;
    released = true;
    if (idleTimerId !== undefined) clearTimeout(idleTimerId);
    idleTimerId = undefined;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    unsubscribeUserFollow();
    unsubscribe();
    assetStore?.destroy();
    assetTarget = undefined;
    transport.close();
  }

  const relayVisibleSceneBounds = (): void => {
    const bounds = getVisibleSceneBounds(options.excalidrawApi.getAppState());
    session.handleViewportChange([bounds[0], bounds[1], bounds[2], bounds[3]]);
  };

  // The engine emits follow changes (avatar click, unfollow-on-interaction,
  // followed peer leaving) only through the imperative API — the `onUserFollow`
  // *prop* exists in upstream's types but is never invoked at runtime — so the
  // subscription is the one wiring that actually works.
  const unsubscribeUserFollow = options.excalidrawApi.onUserFollow(
    (payload: OnUserFollowedPayload): void => {
      if (payload.action !== "FOLLOW") {
        session.handleUserFollow(null);
        return;
      }
      // Collaborators are keyed by peer id (cast to the engine's SocketId),
      // so the clicked avatar's socket id *is* the peer id; parsing instead
      // of casting keeps a malformed value from ever reaching the wire.
      const target = peerIdSchema.safeParse(payload.userToFollow.socketId);
      if (target.success) session.handleUserFollow(target.data);
    },
  );

  session.connect();
  armIdleTimer();
  // Seed the local viewport before any scroll happens: `onScrollChange` only
  // fires on changes, and a member who never scrolls must still be followable.
  relayVisibleSceneBounds();

  return {
    handleSceneChange: (elements, appState) => {
      session.handleLocalSceneChange(elements, appState);
    },
    handlePointerUpdate: (payload) => {
      markActive();
      session.handlePointerUpdate(payload);
    },
    handleScrollChange: relayVisibleSceneBounds,
    getConnectionState: () => session.getConnectionState(),
    destroy() {
      // Leaving may be the room emptying out, and an empty room has no live copy
      // of the scene left — so the durable snapshot has to be brought current
      // here. The flush deliberately outlives `destroy()`: it is a forced write,
      // which is exempt from the teardown guard precisely because the digest it
      // has to compute is asynchronous and every teardown would otherwise abort
      // it in the same tick. It cannot be awaited (React cleanup is synchronous),
      // so the promise is returned for callers that can. After a terminal failure
      // it resolves immediately without writing — a terminated session may no
      // longer vouch for the canvas, so its flush is refused at the guard.
      const flushed = session.flushSnapshot();
      // Aborts in-flight asset transfers and drops the retry timer. Unlike the
      // snapshot flush there is nothing to finish: an upload that has not landed
      // carries bytes still present on this canvas, and a download that has not
      // landed is for a canvas that is going away.
      releaseRoomResources();
      session.destroy();
      return flushed;
    },
  };
}
