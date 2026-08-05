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
import { roomKeySchema } from "@drawstuff/collaboration/realtime-crypto";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";
import { SNAPSHOT_NO_REVISION } from "@drawstuff/collaboration/snapshot";
import {
  createFakeCollaborationNetwork,
  type FakeCollaborationNetwork,
} from "@drawstuff/collaboration/testing";
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  OrderedExcalidrawElement,
  SceneData,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import {
  createCollaborationAssetStore,
  type AssetApi,
  type CollaborationAssetStore,
} from "@/lib/collab/asset-store";
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
/** Authorization generation every client in these tests joined under. */
export const AUTH_GENERATION = 1;
/** Shared room key: asset sealing is real, so the key has to be a real one. */
export const ROOM_KEY = roomKeySchema.parse(
  "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

export type SceneHost = {
  api: CollaborationSceneApi;
  readonly elements: readonly OrderedExcalidrawElement[];
  setElements(next: readonly OrderedExcalidrawElement[]): void;
  readonly collaborators: ReadonlyMap<SocketId, Collaborator>;
  /** captureUpdate of every element-carrying updateScene call, in order. */
  readonly elementCaptureUpdates: readonly (string | undefined)[];
  /** The engine's file store; stands in for what `addFiles` writes into. */
  readonly files: BinaryFiles;
  /** Adds a file the way a local paste does, without notifying the session. */
  putLocalFile(file: BinaryFileData): void;
  /** One entry per `addFiles` call, holding the ids it carried. */
  readonly addedFileBatches: readonly (readonly string[])[];
};

export function createSceneHost(): SceneHost {
  let elements: readonly OrderedExcalidrawElement[] = [];
  let collaborators = new Map<SocketId, Collaborator>();
  const elementCaptureUpdates: (string | undefined)[] = [];
  const files: BinaryFiles = {};
  const addedFileBatches: string[][] = [];
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
      getFiles: () => files,
      addFiles(added) {
        addedFileBatches.push(added.map((file) => file.id));
        for (const file of added) files[file.id] = file;
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
    files,
    putLocalFile(file) {
      files[file.id] = file;
    },
    addedFileBatches,
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
    /** The clock these timers run on, for code that also reads the time. */
    get now() {
      return now;
    },
    /**
     * Earliest scheduled time among live timers, or `undefined` when idle. A
     * timer due at `now` is a zero-delay re-arm — the shape of a spin.
     */
    get nextDueAt(): number | undefined {
      let earliest: number | undefined;
      for (const timer of timers) {
        if (earliest === undefined || timer.at < earliest) earliest = timer.at;
      }
      return earliest;
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

/**
 * In-memory stand-in for the asset backend: the room's asset records plus the
 * object store the ciphertext lands in.
 *
 * Deliberately *not* a stand-in for the sealing. Unlike the snapshot backend
 * above, what these tests need to establish is the whole round trip — a client
 * seals, another client fetches and opens — so the bytes stored here are real
 * ciphertext produced by the real codec against the room key, and `corrupt()`
 * makes a real authentication failure rather than a simulated one.
 *
 * `withholdUploads` models the window that actually exists in production: a peer
 * has broadcast an image element and its upload has not landed yet, which is
 * exactly when a reader's lookup legitimately comes back `missing`.
 */
export function createAssetBackend() {
  type StoredRecord = {
    excalidrawFileId: string;
    cryptoVersion: number;
    byteLength: number;
    url: string;
  };
  const records = new Map<string, StoredRecord>();
  const objects = new Map<string, Uint8Array>();
  /** Uploads accepted by storage but not yet recorded; see `withholdUploads`. */
  const withheld: StoredRecord[] = [];
  let resolveCalls = 0;
  let uploadCalls = 0;
  let fetchCalls = 0;
  let withholdUploads = false;
  let failResolve = false;
  let failUploads = 0;
  let nextKey = 0;
  let peakConcurrentTransfers = 0;
  let activeTransfers = 0;
  let hangingResolve = false;
  let resolveAborted = false;
  let holdNextUpload = false;
  let releaseUpload: (() => void) | undefined;

  const trackTransfer = async <T>(task: () => Promise<T>): Promise<T> => {
    activeTransfers += 1;
    peakConcurrentTransfers = Math.max(
      peakConcurrentTransfers,
      activeTransfers,
    );
    try {
      return await task();
    } finally {
      activeTransfers -= 1;
    }
  };

  const urlFor = (key: string): string =>
    `https://storage.test.invalid/objects/${key}`;
  const keyFromUrl = (url: string): string | undefined => url.split("/").pop();

  return {
    get resolveCalls() {
      return resolveCalls;
    },
    get uploadCalls() {
      return uploadCalls;
    },
    get fetchCalls() {
      return fetchCalls;
    },
    /** Ids the room currently has ciphertext for. */
    storedIds(): string[] {
      return [...records.keys()].sort();
    },
    /** Ciphertext as stored, for assertions about what the server can see. */
    ciphertextFor(fileId: string): Uint8Array | undefined {
      const record = records.get(fileId);
      if (!record) return undefined;
      const key = keyFromUrl(record.url);
      return key ? objects.get(key) : undefined;
    },
    /** Holds uploads out of the record set until `releaseUploads`. */
    withholdUploads(): void {
      withholdUploads = true;
    },
    /** Lands every withheld upload, as a slow upload finishing would. */
    releaseUploads(): void {
      withholdUploads = false;
      for (const record of withheld.splice(0)) {
        if (!records.has(record.excalidrawFileId)) {
          records.set(record.excalidrawFileId, record);
        }
      }
    },
    /** Makes `resolve` throw, as a transport failure would. */
    setFailResolve(value: boolean): void {
      failResolve = value;
    },
    /** Rejects the next `count` uploads, as a transient transport failure would. */
    failNextUploads(count: number): void {
      failUploads = count;
    },
    /** Makes the next upload hang until `releaseHeldUpload`, as a slow one would. */
    holdNextUpload(): void {
      holdNextUpload = true;
    },
    releaseHeldUpload(): void {
      holdNextUpload = false;
      const release = releaseUpload;
      releaseUpload = undefined;
      release?.();
    },
    /** Highest number of transfers this backend ever saw in flight at once. */
    get peakConcurrentTransfers() {
      return peakConcurrentTransfers;
    },
    /** Makes every `resolve` hang, the way an unanswered request does. */
    hangResolve(): void {
      hangingResolve = true;
    },
    /** True once a hanging `resolve` was cancelled through its signal. */
    get resolveAborted() {
      return resolveAborted;
    },
    /** Flips a ciphertext byte in storage: tampering the reader must refuse. */
    corrupt(fileId: string): void {
      const stored = this.ciphertextFor(fileId);
      if (!stored) throw new Error(`no stored asset for ${fileId}`);
      const last = stored.byteLength - 1;
      stored[last] = (stored[last] ?? 0) ^ 0xff;
    },

    createApi(): AssetApi {
      return {
        resolve: ({ fileIds }, signal) => {
          resolveCalls += 1;
          if (failResolve) return Promise.reject(new Error("resolve failed"));
          if (hangingResolve) {
            // A request nothing answers: only the signal can end it, which is what
            // teardown has to be able to do.
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                resolveAborted = true;
                reject(new Error("aborted"));
              });
            });
          }
          const assets = fileIds
            .map((fileId) => records.get(fileId))
            .filter((record): record is StoredRecord => record !== undefined);
          const available = new Set(
            assets.map((asset) => asset.excalidrawFileId),
          );
          return Promise.resolve({
            authGeneration: AUTH_GENERATION,
            assets,
            missing: fileIds.filter((fileId) => !available.has(fileId)),
          });
        },
        upload: ({ excalidrawFileId, cryptoVersion, ciphertext }) =>
          trackTransfer(async () => {
            uploadCalls += 1;
            if (failUploads > 0) {
              failUploads -= 1;
              throw new Error("upload failed");
            }
            if (holdNextUpload) {
              holdNextUpload = false;
              await new Promise<void>((resolve) => {
                releaseUpload = resolve;
              });
            }
            nextKey += 1;
            const key = `object-${nextKey}`;
            objects.set(key, Uint8Array.from(ciphertext));
            const record: StoredRecord = {
              excalidrawFileId,
              cryptoVersion,
              byteLength: ciphertext.byteLength,
              url: urlFor(key),
            };
            if (withholdUploads) {
              withheld.push(record);
              return;
            }
            // Identity wins over arrival order, the way the real insert does.
            if (!records.has(excalidrawFileId)) {
              records.set(excalidrawFileId, record);
            }
            await Promise.resolve();
          }),
      };
    },

    /**
     * `fetch` over the object store; the store reads ciphertext through this.
     *
     * Deliberately takes a macrotask to answer, so overlapping downloads really do
     * overlap and `peakConcurrentTransfers` measures something.
     */
    createFetch(): typeof fetch {
      return ((input: RequestInfo | URL) =>
        trackTransfer(async () => {
          fetchCalls += 1;
          const url = typeof input === "string" ? input : String(input);
          const key = keyFromUrl(url);
          const bytes = key ? objects.get(key) : undefined;
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (!bytes) return new Response(null, { status: 404 });
          return new Response(Uint8Array.from(bytes), { status: 200 });
        })) as typeof fetch;
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
      assetStore?: CollaborationAssetStore;
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
      assetStore: options.assetStore,
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

  /**
   * A client with a real asset store attached to a fake backend.
   *
   * The store hands opened assets to the session and the session asks the store
   * for them, so the wiring is the same late binding production uses
   * (`room-session.ts`): the callback is installed the moment the session exists.
   * Retry backoff runs on the returned manual timers, so no assertion waits.
   */
  const createAssetClient = async (
    name: string,
    backend: AssetBackend,
    options: {
      role?: RoomRole;
      snapshotStore?: CollaborationSnapshotStore;
      canSyncScene?: () => boolean;
      joinBarrier?: JoinBarrierOptions;
    } = {},
  ): Promise<AssetTestClient> => {
    const assetTimers = createManualTimers();
    let target: CollaborationSession | undefined;
    const assetStore = await createCollaborationAssetStore({
      api: backend.createApi(),
      roomId: ROOM_ID,
      roomKey: ROOM_KEY,
      authGeneration: AUTH_GENERATION,
      onAssetsResolved: (files) => {
        target?.applyRemoteAssets(files);
      },
      onPublishRetryDue: () => {
        target?.republishLocalAssets();
      },
      scheduleTimeout: assetTimers.schedule,
      now: () => assetTimers.now,
      fetchImpl: backend.createFetch(),
    });
    const client = createClient(name, { ...options, assetStore });
    target = client.session;
    return { ...client, assetStore, assetTimers };
  };

  return { network, clock, createClient, createAssetClient, settle };
}

export type AssetBackend = ReturnType<typeof createAssetBackend>;

export type AssetTestClient = TestClient & {
  assetStore: CollaborationAssetStore;
  /** Drives the asset store's retry backoff. */
  assetTimers: ReturnType<typeof createManualTimers>;
};

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

