import type { PresenceMessage } from "@drawstuff/collaboration/protocol";
import type { ConnectionState } from "@drawstuff/collaboration/transport";
import type {
  BinaryFileData,
  BinaryFiles,
  OrderedExcalidrawElement,
  SceneData,
} from "@drawstuff/excalidraw-adapter/types";
import type { ReconciliationLocalState } from "@drawstuff/excalidraw-adapter/reconcile";

/**
 * The seam the session's parts share.
 *
 * The orchestrator (`collaboration-session.ts`) owns the mutable connection
 * state and the teardown flags; every part reads them through this object, so
 * the previously implicit rule of "who may read `connected`" is now a checkable
 * dependency: a part that needs it declares it, and nothing else can reach it.
 */

export type ConnectedState = Extract<ConnectionState, { status: "connected" }>;

/**
 * The slice of `ExcalidrawImperativeAPI` the session reads and writes, kept
 * minimal so tests can drive the session with a plain in-memory scene host.
 */
export type CollaborationSceneApi = {
  getSceneElementsIncludingDeleted(): readonly OrderedExcalidrawElement[];
  getAppState(): ReconciliationLocalState;
  updateScene(
    sceneData: Pick<SceneData, "elements" | "collaborators" | "captureUpdate">,
  ): void;
  /**
   * The engine's binary file store. It is the session's cache of decrypted
   * assets — the asset store keeps ids only — so "which images do I still need"
   * and "which images can I publish" are both answered from here.
   */
  getFiles(): BinaryFiles;
  addFiles(files: BinaryFileData[]): void;
};

export type SessionContext = {
  /** Live connection, or `undefined` between sockets. */
  readonly connected: ConnectedState | undefined;
  /**
   * A viewer never produces scene traffic. The relay refuses it anyway (and
   * closes the socket for trying), so this keeps a read-only session from
   * disconnecting itself; presence remains allowed for both roles.
   * Also false while the canvas no longer holds this room's scene.
   */
  canEditScene(): boolean;
  /**
   * Checked synchronously before every scene read or write. When it returns
   * false the canvas no longer holds this room's scene, so the session neither
   * broadcasts what is on it nor applies room traffic to it. Presence is
   * unaffected: it carries no scene state.
   */
  canSyncScene(): boolean;
  /**
   * True once this session will never do useful work again — torn down by the
   * caller, or stopped by a terminal recovery failure. The editor keeps calling
   * in either case, so entry points that would otherwise walk the scene,
   * measure elements or build messages check this first.
   */
  isStopped(): boolean;
  now(): number;
  /** Schedules a one-shot timer and returns its cancel function. */
  scheduleTimeout(run: () => void, delayMs: number): () => void;
  sceneApi: CollaborationSceneApi;
};

/** The shared header of every outbound message; the orchestrator builds it. */
export type MessageEnvelope = Pick<
  PresenceMessage,
  | "protocolVersion"
  | "messageId"
  | "roomId"
  | "roomGeneration"
  | "senderPeerId"
  | "sequence"
>;

export type BuildEnvelope = (
  session: ConnectedState,
  sequence: number,
) => MessageEnvelope;
