import { expect } from "vitest";

import {
  clientIdSchema,
  roomIdSchema,
  type ClientId,
  type CollaborationMessage,
  type SceneMessage,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import type { JoinBarrierOptions } from "@drawstuff/collaboration/join-barrier";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";
import { SNAPSHOT_NO_REVISION } from "@drawstuff/collaboration/snapshot";
import {
  createFakeCollaborationNetwork,
  type FakeCollaborationNetwork,
} from "@drawstuff/collaboration/testing";
import type {
  Collaborator,
  OrderedExcalidrawElement,
  SceneData,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import {
  createCollaborationSession,
  type BaselineOutcome,
  type CollaborationSceneApi,
  type CollaborationSession,
} from "@/lib/collab/collaboration-session";
import type { CollaborationSnapshotStore } from "@/lib/collab/snapshot-store";
import {
  COLLAB_SCENE_FIXED_NOW,
  collabAppState,
  sortSceneById,
} from "./collab-scene-fixtures";

export const ROOM_ID = roomIdSchema.parse("room-poc");
/** The fake network models delivery, not token verification. */
export const JOIN_TOKEN = "test-join-token";

export type SceneHost = {
  api: CollaborationSceneApi;
  readonly elements: readonly OrderedExcalidrawElement[];
  setElements(next: readonly OrderedExcalidrawElement[]): void;
  readonly collaborators: ReadonlyMap<SocketId, Collaborator>;
  /** captureUpdate of every element-carrying updateScene call, in order. */
  readonly elementCaptureUpdates: readonly (string | undefined)[];
};

export function createSceneHost(): SceneHost {
  let elements: readonly OrderedExcalidrawElement[] = [];
  let collaborators = new Map<SocketId, Collaborator>();
  const elementCaptureUpdates: (string | undefined)[] = [];
  const localState = {
    editingTextElement: null,
    newElement: null,
    resizingElement: null,
  };

  return {
    api: {
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => localState,
      updateScene(
        sceneData: Pick<
          SceneData,
          "elements" | "collaborators" | "captureUpdate"
        >,
      ) {
        if (sceneData.elements) {
          elements = sceneData.elements as readonly OrderedExcalidrawElement[];
          elementCaptureUpdates.push(sceneData.captureUpdate);
        }
        if (sceneData.collaborators) {
          collaborators = sceneData.collaborators;
        }
      },
    },
    get elements() {
      return elements;
    },
    setElements(next) {
      elements = next;
    },
    get collaborators() {
      return collaborators;
    },
    elementCaptureUpdates,
  };
}

export function createManualScheduler() {
  const queue: (() => void)[] = [];
  let cancelledCount = 0;
  return {
    schedule(flush: () => void): () => void {
      queue.push(flush);
      return () => {
        const index = queue.indexOf(flush);
        if (index !== -1) {
          queue.splice(index, 1);
          cancelledCount += 1;
        }
      };
    },
    /** Runs only the flushes queued before the call: a flush that re-schedules
     *  itself (overflow retry) waits for the next runAll, mirroring "next
     *  animation frame" semantics without looping forever. */
    runAll(): void {
      const batch = queue.splice(0);
      for (const flush of batch) flush();
    },
    get pendingCount() {
      return queue.length;
    },
    get cancelledCount() {
      return cancelledCount;
    },
  };
}

/**
 * Deterministic replacement for `setTimeout`, matching the session's
 * `scheduleTimeout` contract. The join deadline and the snapshot cadence are
 * both real timers in production; here they only fire when a test says so, so no
 * assertion depends on wall time or on a sleep.
 */
export function createManualTimers() {
  let now = 0;
  let nextId = 1;
  let timers: { id: number; at: number; run: () => void }[] = [];

  return {
    schedule(run: () => void, delayMs: number): () => void {
      const id = nextId;
      nextId += 1;
      timers.push({ id, at: now + delayMs, run });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    /** Advances the clock and fires everything due, in scheduled order. */
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= now)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) return;
        timers = timers.filter((timer) => timer !== due);
        due.run();
      }
    },
    /** Live timer count; a torn-down session must leave none behind. */
    get pendingCount() {
      return timers.length;
    },
  };
}

/**
 * In-memory stand-in for the durable snapshot backend.
 *
 * Deliberately not encrypted: sealing is the collaboration package's contract
 * and is covered there against real Web Crypto in Chromium and WebKit. What these
 * tests need is the *store's* behaviour — revisions, conflicts, and the failure
 * outcomes a client has to survive — and an unencrypted backend keeps every
 * assertion synchronous and readable.
 */
export function createSnapshotBackend() {
  let revision = SNAPSHOT_NO_REVISION;
  let elements: readonly SyncedElement[] = [];
  const saves: { expectedRevision: number; count: number }[] = [];
  /** Loads held open by `deferLoad`, released together. */
  const deferred: (() => void)[] = [];
  let loads = 0;

  return {
    get revision() {
      return revision;
    },
    get elements() {
      return elements;
    },
    /** Simulates another client publishing a newer baseline out of band. */
    publish(next: readonly SyncedElement[]): void {
      revision += 1;
      elements = next;
    },
    /** Load calls made so far; a conflict must cause a re-read. */
    get loadCount() {
      return loads;
    },
    /** Conditional writes recorded in order, for asserting retry behaviour. */
    get saves(): readonly { expectedRevision: number; count: number }[] {
      return saves;
    },
    /** Completes every load this backend is holding open. */
    resolveDeferredLoads(): void {
      const waiting = deferred.splice(0);
      for (const resolve of waiting) resolve();
    },

    /**
     * A client's view of the backend.
     *
     * `outcome` forces the failure paths a real client has to handle: a link with
     * the wrong key, and a fetch that fails. `deferLoad` holds the fetch open
     * until `resolveDeferredLoads()`, which is how a test puts a joiner in the
     * state the barrier exists for — subscribed, holding, no baseline yet.
     */
    createStore(
      options: {
        outcome?: "wrong-key" | "unavailable";
        deferLoad?: boolean;
      } = {},
    ): CollaborationSnapshotStore {
      const gate = (): Promise<void> => {
        if (!options.deferLoad) return Promise.resolve();
        return new Promise<void>((resolve) => deferred.push(resolve));
      };
      return {
        load: async () => {
          loads += 1;
          await gate();
          if (options.outcome) {
            return { status: "unreadable" as const, reason: options.outcome };
          }
          if (revision === SNAPSHOT_NO_REVISION) {
            return { status: "empty" as const };
          }
          return { status: "loaded" as const, revision, elements };
        },
        save: ({ elements: next, expectedRevision }) => {
          saves.push({ expectedRevision, count: next.length });
          if (expectedRevision !== revision) {
            return Promise.resolve({
              status: "conflict" as const,
              currentRevision:
                revision === SNAPSHOT_NO_REVISION ? undefined : revision,
            });
          }
          revision += 1;
          elements = next;
          return Promise.resolve({ status: "written" as const, revision });
        },
      };
    },
  };
}

export type TestClient = {
  host: SceneHost;
  session: CollaborationSession;
  scheduler: ReturnType<typeof createManualScheduler>;
  timers: ReturnType<typeof createManualTimers>;
  clientId: ClientId;
  baselineOutcomes: readonly BaselineOutcome[];
  /** Mutates the host scene, notifies the session, and runs the flush. */
  edit(
    mutate: (
      elements: readonly OrderedExcalidrawElement[],
    ) => readonly OrderedExcalidrawElement[],
  ): void;
};

export function createHarness() {
  const network = createFakeCollaborationNetwork();
  const clock = { now: COLLAB_SCENE_FIXED_NOW };

  const createClient = (
    name: string,
    options: {
      role?: RoomRole;
      snapshotStore?: CollaborationSnapshotStore;
      canSyncScene?: () => boolean;
      joinBarrier?: JoinBarrierOptions;
    } = {},
  ): TestClient => {
    const host = createSceneHost();
    const scheduler = createManualScheduler();
    const timers = createManualTimers();
    const clientId = clientIdSchema.parse(name);
    const baselineOutcomes: BaselineOutcome[] = [];
    const session = createCollaborationSession({
      transport: network.createTransport({ role: options.role }),
      roomId: ROOM_ID,
      clientId,
      joinToken: JOIN_TOKEN,
      username: name,
      sceneApi: host.api,
      snapshotStore: options.snapshotStore,
      canSyncScene: options.canSyncScene,
      joinBarrier: options.joinBarrier,
      scheduleSceneFlush: scheduler.schedule,
      scheduleTimeout: timers.schedule,
      onBaselineResolved: (outcome) => baselineOutcomes.push(outcome),
      now: () => clock.now,
    });
    return {
      host,
      session,
      scheduler,
      timers,
      clientId,
      baselineOutcomes,
      edit(mutate) {
        host.setElements(mutate(host.elements));
        session.handleLocalSceneChange(host.elements, collabAppState());
        scheduler.runAll();
      },
    };
  };

  /**
   * Runs the network until nothing is in flight.
   *
   * Joining is a multi-round exchange now: the joiner holds inbound traffic
   * behind its barrier, an elected peer answers with a snapshot, and the joiner
   * broadcasts its own once the baseline lands. Tests that care about "what
   * happens next" need that exchange finished first, and it terminates on its
   * own — `sceneInitNeedsReply` produces no reply between equal states.
   */
  const settle = (maxRounds = 10): void => {
    for (let round = 0; round < maxRounds; round += 1) {
      if (network.pendingMessageCount() === 0) return;
      network.flush();
    }
    throw new Error("collaboration exchange did not settle");
  };

  return { network, clock, createClient, settle };
}

export function expectConverged(a: TestClient, b: TestClient): void {
  expect(sortSceneById(a.host.elements)).toEqual(
    sortSceneById(b.host.elements),
  );
}

/** Crafts protocol messages from a raw transport's connected session. */
export function createRawSender(network: FakeCollaborationNetwork, name: string) {
  const transport = network.createTransport();
  transport.connect({
    roomId: ROOM_ID,
    clientId: clientIdSchema.parse(name),
    joinToken: JOIN_TOKEN,
  });
  const state = transport.getConnectionState();
  if (state.status !== "connected") throw new Error("raw sender not connected");
  const received: CollaborationMessage[] = [];
  transport.subscribe({
    onMessage: (message) => {
      received.push(message);
    },
  });
  let messageCounter = 0;
  const sceneMessage = (input: {
    type?: SceneMessage["type"];
    sequence: number;
    elements: readonly OrderedExcalidrawElement[];
  }): SceneMessage => ({
    protocolVersion: 1,
    messageId: `raw-${(messageCounter += 1)}`,
    roomId: state.roomId,
    roomGeneration: state.roomGeneration,
    senderClientId: state.clientId,
    senderPeerId: state.peerId,
    sequence: input.sequence,
    type: input.type ?? "scene-update",
    payload: { elements: input.elements as unknown as SyncedElement[] },
  });
  return { transport, state, received, sceneMessage };
}

