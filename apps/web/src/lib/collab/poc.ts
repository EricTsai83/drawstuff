import { nanoid } from "nanoid";

import {
  clientIdSchema,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawPointerUpdatePayload,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import {
  createBroadcastChannelTransport,
  type BroadcastChannelTransportOptions,
} from "@/lib/collab/broadcast-channel-transport";
import {
  createCollaborationSession,
  type CollaborationSceneApi,
} from "@/lib/collab/collaboration-session";

/**
 * Plan 11 POC runtime wiring: BroadcastChannel transport + collaboration
 * session + idle detection + E2E introspection hook. Loaded only through the
 * feature-gated dynamic import in `use-collaboration-poc.ts` and deleted in
 * Plan 12 when the relay transport replaces the local wiring.
 */

/** Mirrors the upstream collab app's idle detection thresholds. */
const IDLE_THRESHOLD_MS = 60_000;

export const COLLAB_POC_ROOM_PARAM = "collab-room";
export const COLLAB_POC_USER_PARAM = "collab-user";
const MAX_USERNAME_LENGTH = 128;

export type CollabPocHandle = {
  handleSceneChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ): void;
  handlePointerUpdate(payload: ExcalidrawPointerUpdatePayload): void;
  destroy(): void;
};

type CollabPocTestHook = {
  /** Canonical JSON of the full scene (including tombstones), sorted by
   *  element id — two converged clients return the same string. */
  getSceneSnapshot(): string;
  getCollaboratorUsernames(): string[];
};

declare global {
  interface Window {
    __drawstuffCollabPoc?: CollabPocTestHook;
  }
}

export type StartCollabPocOptions = {
  excalidrawApi: ExcalidrawImperativeAPI;
  roomIdRaw: string;
  usernameRaw: string | null;
  wrapRemoteApply: (apply: () => void) => void;
  transportOptions?: BroadcastChannelTransportOptions;
};

export function startCollabPoc(
  options: StartCollabPocOptions,
): CollabPocHandle | undefined {
  const roomId = roomIdSchema.safeParse(options.roomIdRaw);
  if (!roomId.success) {
    console.warn(
      `Collab POC: invalid room id "${options.roomIdRaw}" — expected 1-64 chars of [A-Za-z0-9_-]`,
    );
    return undefined;
  }
  if (
    options.transportOptions?.createChannel === undefined &&
    typeof BroadcastChannel === "undefined"
  ) {
    console.warn("Collab POC: BroadcastChannel is not available");
    return undefined;
  }

  const clientId = clientIdSchema.parse(`client-${nanoid()}`);
  const username =
    options.usernameRaw?.trim().slice(0, MAX_USERNAME_LENGTH) ||
    `guest-${clientId.slice(-4)}`;

  const excalidrawApi = options.excalidrawApi;
  const sceneApi: CollaborationSceneApi = excalidrawApi;
  const transport = createBroadcastChannelTransport(options.transportOptions);
  const session = createCollaborationSession({
    transport,
    roomId: roomId.data,
    clientId,
    username,
    sceneApi,
    wrapRemoteApply: options.wrapRemoteApply,
  });

  // Upstream-style idle detection: pointer activity arms an idle timeout,
  // tab visibility flips between away and active.
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
    } else {
      markActive();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Canonical form for digest comparison: recursively sorted keys (wire
  // decoding reorders JSON keys) and upstream restore's `boundElements`
  // null → [] normalization, so a sender's fresh element and the receiver's
  // restored copy serialize identically.
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };

  const testHook: CollabPocTestHook = {
    getSceneSnapshot() {
      const elements = [...excalidrawApi.getSceneElementsIncludingDeleted()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((element) =>
          canonicalize({ ...element, boundElements: element.boundElements ?? [] }),
        );
      return JSON.stringify(elements);
    },
    getCollaboratorUsernames() {
      const collaborators = excalidrawApi.getAppState().collaborators;
      return [...collaborators.values()]
        .map((collaborator) => collaborator.username ?? "")
        .filter((name) => name.length > 0)
        .sort();
    },
  };
  window.__drawstuffCollabPoc = testHook;

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
    destroy() {
      if (idleTimerId !== undefined) clearTimeout(idleTimerId);
      idleTimerId = undefined;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (window.__drawstuffCollabPoc === testHook) {
        delete window.__drawstuffCollabPoc;
      }
      session.destroy();
      transport.close();
    },
  };
}
