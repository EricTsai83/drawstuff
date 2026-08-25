import { describe, expect, it, vi } from "vitest";

import { TRPCClientError } from "@trpc/client";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  generateRoomKey,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
import { SNAPSHOT_NO_REVISION } from "@drawstuff/collaboration/snapshot";
import type {
  BinaryFileData,
  DataURL,
  FileId,
} from "@drawstuff/excalidraw-adapter/types";

import { drainAsync } from "./support/async-drain";
import { classifyJoinFailure } from "@/lib/collab/join-failure";
import {
  createCollaborationAssetStore,
  type AssetApi,
} from "@/lib/collab/asset-store";
import {
  COLLAB_RATE_LIMITED_ERROR,
  rateLimitRetryAfterMs,
} from "@/lib/collab/rate-limit";
import {
  createCollaborationSnapshotStore,
  type SnapshotApi,
} from "@/lib/collab/snapshot-store";
import { SNAPSHOT_INTERVAL_MS } from "@/lib/collab/collaboration-session";
import {
  collabRectangle,
  COLLAB_SCENE_FIXED_NOW,
} from "./support/collab-scene-fixtures";
import {
  createHarness,
  createManualTimers,
  createSnapshotBackend,
} from "./support/collab-session-harness";

/**
 * How a client reacts to being rate limited.
 *
 * Two rules, and they pull in opposite directions on purpose. A rate limit is
 * *transient*, so it must not be classified as a permission problem or as a
 * terminal failure — a session that gives up on one has abandoned a room it
 * could have rejoined a minute later. And it is *shared*, so a retry inside the
 * window spends a token that was going to be refused anyway and pushes the
 * deadline out for everyone counting against the same budget. Hence: retry, but
 * never before the instant the server named, and never with more attempts than
 * the existing bounded budget already granted.
 *
 * Every deadline here is read from a field. Nothing parses a message.
 */

const ROOM_ID = roomIdSchema.parse("room-rate-limit");
const AUTH_GENERATION = 1;
const FILE_A = "a".repeat(40);

/** The tRPC refusal, exactly as `errorFormatter` shapes it on the wire. */
const trpcRateLimitError = (retryAfterMs: number): TRPCClientError<never> => {
  const error = new TRPCClientError<never>("Too many collaboration requests.");
  Object.assign(error, {
    data: {
      code: "TOO_MANY_REQUESTS",
      rateLimit: { reset: 1_770_000_000_000, retryAfterMs },
    },
  });
  return error;
};

/** The UploadThing refusal: a 429 body handed back as the error's `cause`. */
const uploadRateLimitError = (retryAfterMs: number): Error => {
  const error = new Error("Request failed with status 429");
  Object.assign(error, {
    cause: {
      error: COLLAB_RATE_LIMITED_ERROR,
      operation: "asset-upload",
      reset: 1_770_000_000_000,
      retryAfterMs,
    },
  });
  return error;
};

describe("classifying a refusal", () => {
  it("reads the deadline off a tRPC error's data", () => {
    expect(rateLimitRetryAfterMs(trpcRateLimitError(30_000))).toBe(30_000);
  });

  it("reads the deadline off an UploadThing error's body", () => {
    // The library maps 429 to `INTERNAL_SERVER_ERROR`, so the discriminator has
    // to come from the body this app owns rather than from the error code.
    expect(rateLimitRetryAfterMs(uploadRateLimitError(9_000))).toBe(9_000);
  });

  it("ignores everything that is not a rate limit", () => {
    const forbidden = new TRPCClientError<never>("nope");
    Object.assign(forbidden, { data: { code: "FORBIDDEN", rateLimit: null } });
    expect(rateLimitRetryAfterMs(forbidden)).toBeNull();
    expect(rateLimitRetryAfterMs(new Error("network"))).toBeNull();
    expect(rateLimitRetryAfterMs(undefined)).toBeNull();
    // A body that merely looks similar carries no deadline anybody can trust.
    expect(
      rateLimitRetryAfterMs({ cause: { error: "SOMETHING_ELSE", reset: 1 } }),
    ).toBeNull();
  });

  it("never reports a negative wait", () => {
    expect(rateLimitRetryAfterMs(trpcRateLimitError(-5_000))).toBe(0);
  });
});

describe("join", () => {
  it("treats a rate limit as retryable, carrying the server's deadline", () => {
    // Not `unauthorized` and not `room-ended`: those stop recovery for good,
    // and this room is perfectly reachable in a minute.
    expect(classifyJoinFailure(trpcRateLimitError(25_000))).toEqual({
      ok: false,
      retry: true,
      retryAfterMs: 25_000,
    });
  });

  it("leaves the terminal classifications alone", () => {
    const withCode = (code: string): TRPCClientError<never> => {
      const error = new TRPCClientError<never>(code);
      Object.assign(error, { data: { code } });
      return error;
    };
    expect(classifyJoinFailure(withCode("FORBIDDEN"))).toEqual({
      ok: false,
      retry: false,
      failure: "membership-revoked",
    });
    expect(classifyJoinFailure(withCode("PRECONDITION_FAILED"))).toEqual({
      ok: false,
      retry: false,
      failure: "room-ended",
    });
    expect(classifyJoinFailure(new Error("offline"))).toEqual({
      ok: false,
      retry: true,
      // No deadline stated, so the recovery machine's own backoff decides.
      retryAfterMs: undefined,
    });
  });
});

describe("snapshot writes", () => {
  const storeWith = (put: SnapshotApi["put"], roomKey: RoomKey) =>
    createCollaborationSnapshotStore({
      api: {
        get: () =>
          Promise.resolve({ authGeneration: AUTH_GENERATION, snapshot: null }),
        put,
      },
      roomId: ROOM_ID,
      roomKey,
      authGeneration: AUTH_GENERATION,
    });

  it("reports a rate limit as its own outcome, with the wait", async () => {
    // Folded into `failed` this would be retried on the caller's own 30 s
    // cadence, straight back into a window that has not reset.
    const store = await storeWith(
      () => Promise.reject(trpcRateLimitError(40_000)),
      generateRoomKey(),
    );
    await expect(
      store.save({ elements: [], expectedRevision: SNAPSHOT_NO_REVISION }),
    ).resolves.toEqual({ status: "rate-limited", retryAfterMs: 40_000 });
  });

  it("still reports an ordinary transport failure as failed", async () => {
    const store = await storeWith(
      () => Promise.reject(new Error("offline")),
      generateRoomKey(),
    );
    await expect(
      store.save({ elements: [], expectedRevision: SNAPSHOT_NO_REVISION }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("passes cadence and leave intent through to the server", async () => {
    const put = vi.fn<SnapshotApi["put"]>(() =>
      Promise.resolve({ status: "written", revision: 1 }),
    );
    const store = await storeWith(put, generateRoomKey());

    await store.save({
      elements: [],
      expectedRevision: SNAPSHOT_NO_REVISION,
    });
    await store.save({
      elements: [],
      expectedRevision: SNAPSHOT_NO_REVISION,
      intent: "leave",
    });

    expect(put.mock.calls.map(([input]) => input.intent)).toEqual([
      "cadence",
      "leave",
    ]);
  });
});

describe("asset lookups", () => {
  const RETRY_AFTER_MS = 45_000;

  const storeWith = async (
    api: AssetApi,
    timers: ReturnType<typeof createManualTimers>,
  ) =>
    createCollaborationAssetStore({
      api,
      roomId: ROOM_ID,
      roomKey: generateRoomKey(),
      authGeneration: AUTH_GENERATION,
      onAssetsResolved: () => undefined,
      scheduleTimeout: (run, delayMs) => timers.schedule(run, delayMs),
      now: () => timers.now,
    });

  const rejectingApi = (error: unknown): AssetApi & { calls: number } => {
    const api = {
      calls: 0,
      resolve: () => {
        api.calls += 1;
        return Promise.reject(error);
      },
      upload: () => Promise.resolve(),
    };
    return api as unknown as AssetApi & { calls: number };
  };

  it("does not look the id up again before the server's window resets", async () => {
    const timers = createManualTimers();
    const api = rejectingApi(trpcRateLimitError(RETRY_AFTER_MS));
    const store = await storeWith(api, timers);

    await store.request([FILE_A]);
    expect(api.calls).toBe(1);
    // The retry chain is armed for no earlier than the stated reset — the local
    // backoff for a first failure is a second, which would land inside it.
    expect(timers.nextDueAt).toBeGreaterThanOrEqual(RETRY_AFTER_MS);

    // Fresh traffic naming the same id inside the window must not re-ask
    // either: that is the path that turns a busy room into a request loop.
    timers.advance(RETRY_AFTER_MS - 1_000);
    await store.request([FILE_A]);
    expect(api.calls).toBe(1);

    timers.advance(2_000);
    await store.request([FILE_A]);
    expect(api.calls).toBe(2);
    store.destroy();
  });

  it("keeps the ordinary backoff when the failure is not a rate limit", async () => {
    const timers = createManualTimers();
    const api = rejectingApi(new Error("offline"));
    const store = await storeWith(api, timers);

    await store.request([FILE_A]);
    // A server deadline raises the delay; its absence must not change it.
    expect(timers.nextDueAt).toBeLessThan(RETRY_AFTER_MS);
    store.destroy();
  });

  it("still gives up after the bounded chain, budget unchanged", async () => {
    // A rate limit delays attempts; it does not buy extra ones. Four scheduled
    // attempts remain four, so a permanently refused id stops asking.
    const timers = createManualTimers();
    const api = rejectingApi(trpcRateLimitError(1_000));
    const store = await storeWith(api, timers);

    await store.request([FILE_A]);
    for (let round = 0; round < 8; round += 1) timers.advance(60_000);
    expect(api.calls).toBeLessThanOrEqual(4);
    store.destroy();
  });
});

/**
 * Waits for observable async work rather than assuming Web Crypto settles in a
 * fixed number of turns. The bound still turns a real stall into a useful test
 * failure, while avoiding scheduler-speed assertions in the full parallel
 * suite.
 */
const waitForAsync = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    if (predicate()) return;
    await drainAsync();
  }
  throw new Error(`timed out waiting for ${label}`);
};

const settleRoom = async (
  harness: ReturnType<typeof createHarness>,
): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    await drainAsync();
    if (harness.network.pendingMessageCount() === 0) return;
    harness.network.flush();
  }
  throw new Error("collaboration exchange did not settle");
};

describe("the snapshot cadence", () => {
  /** A backend whose writes are refused by the room's shared budget. */
  const rateLimitedBackend = (retryAfterMs: number) => {
    const backend = createSnapshotBackend();
    const inner = backend.createStore();
    let refusals = 0;
    let saveCalls = 0;
    let refuse = true;
    return {
      get saveAttempts() {
        return backend.saves.length;
      },
      /** Every write that reached the backend, refused or not. */
      get saveCalls() {
        return saveCalls;
      },
      get refusals() {
        return refusals;
      },
      stopRefusing(): void {
        refuse = false;
      },
      store: {
        load: () => inner.load(),
        save: (input: Parameters<typeof inner.save>[0]) => {
          saveCalls += 1;
          if (!refuse) return inner.save(input);
          refusals += 1;
          return Promise.resolve({
            status: "rate-limited" as const,
            retryAfterMs,
          });
        },
      },
    };
  };

  it("stops writing until the room's window resets, then resumes", async () => {
    const RETRY_AFTER_MS = SNAPSHOT_INTERVAL_MS * 3;
    const harness = createHarness();
    const backend = rateLimitedBackend(RETRY_AFTER_MS);
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.store,
    });
    alice.session.connect();
    await settleRoom(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settleRoom(harness);

    // First cadence tick: the elected writer tries once and is refused.
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await waitForAsync(() => backend.refusals === 1, "snapshot refusal");
    expect(backend.refusals).toBe(1);

    // Ticking again inside the window is a round trip that cannot succeed, so
    // the cadence holds off until the server's stated reset.
    for (let tick = 0; tick < 2; tick += 1) {
      alice.timers.advance(SNAPSHOT_INTERVAL_MS);
      harness.clock.now += SNAPSHOT_INTERVAL_MS;
      await drainAsync();
    }
    expect(backend.refusals).toBe(1);

    // Past the stated reset, the ordinary cadence resumes on its own: a rate
    // limit delays the room's backup, it does not end it.
    backend.stopRefusing();
    harness.clock.now = COLLAB_SCENE_FIXED_NOW + RETRY_AFTER_MS + 1;
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await waitForAsync(
      () => backend.saveAttempts > 0,
      "snapshot write after reset",
    );
    expect(backend.saveAttempts).toBeGreaterThan(0);
    alice.session.destroy();
  });

  it("still flushes on leave inside the window, because skipping is the costlier error", async () => {
    const RETRY_AFTER_MS = SNAPSHOT_INTERVAL_MS * 3;
    const harness = createHarness();
    const backend = rateLimitedBackend(RETRY_AFTER_MS);
    const alice = harness.createClient("client-alice", {
      snapshotStore: backend.store,
    });
    alice.session.connect();
    await settleRoom(harness);
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    await settleRoom(harness);

    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    await drainAsync();
    expect(backend.saveCalls).toBe(1);

    // A cadence tick inside the window is still held back...
    alice.timers.advance(SNAPSHOT_INTERVAL_MS);
    harness.clock.now += SNAPSHOT_INTERVAL_MS;
    await drainAsync();
    expect(backend.saveCalls).toBe(1);

    // ...but the leave flush is not, and the asymmetry is the whole point. A
    // refused sliding-window request consumes no token, so attempting takes
    // nothing from the members who stayed; skipping can lose the room's newest
    // state for good, because teardown stops the cadence and there is no later
    // tick to pick the edit up.
    alice.edit((elements) => [...elements, collabRectangle({ id: "r2" })]);
    await settleRoom(harness);
    await alice.session.flushSnapshot();
    expect(backend.saveCalls).toBe(2);

    alice.session.destroy();
  });
});

describe("asset uploads", () => {
  const FILE_B = "b".repeat(40);
  const RETRY_AFTER_MS = 50_000;

  const imageFile = (fileId: string): BinaryFileData => ({
    id: fileId as FileId,
    dataURL: "data:image/png;base64,AAECAwQFBgcICQoLDA0OD" as DataURL,
    mimeType: "image/png",
    created: 1_710_000_000_000,
    lastRetrieved: 1_710_000_000_000,
  });

  /**
   * A store whose uploads fail in a scripted, per-file way.
   *
   * `onPublishRetryDue` is left unwired in the tests that drive `publish`
   * directly: those are about the *scene-flush* path back into the store, and a
   * live retry timer would make it ambiguous which path re-attempted.
   */
  const uploadStore = async (options: {
    timers: ReturnType<typeof createManualTimers>;
    upload: (fileId: string) => Promise<void>;
    onPublishRetryDue?: () => void;
    onAssetsUnavailable?: (fileIds: readonly string[]) => void;
  }) =>
    createCollaborationAssetStore({
      api: {
        resolve: () =>
          Promise.resolve({
            authGeneration: AUTH_GENERATION,
            assets: [],
            missing: [],
          }),
        upload: (input) => options.upload(input.excalidrawFileId),
      },
      roomId: ROOM_ID,
      roomKey: generateRoomKey(),
      authGeneration: AUTH_GENERATION,
      onAssetsResolved: () => undefined,
      onAssetsUnavailable: options.onAssetsUnavailable,
      onPublishRetryDue: options.onPublishRetryDue,
      scheduleTimeout: (run, delayMs) => options.timers.schedule(run, delayMs),
      now: () => options.timers.now,
    });

  it("does not offer the file again before the server's window resets", async () => {
    const timers = createManualTimers();
    let retriesDue = 0;
    const store = await uploadStore({
      timers,
      upload: () => Promise.reject(uploadRateLimitError(RETRY_AFTER_MS)),
      onPublishRetryDue: () => {
        retriesDue += 1;
      },
    });

    await store.publish([imageFile(FILE_A)]);

    expect(timers.nextDueAt).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
    timers.advance(RETRY_AFTER_MS - 1_000);
    expect(retriesDue).toBe(0);
    timers.advance(2_000);
    expect(retriesDue).toBe(1);
    store.destroy();
  });

  it("lets the longest deadline in a round own the timer", async () => {
    // The store keeps one timer. Whichever file fails first would otherwise pin
    // it: an ordinary transport error backs off about a second, which would drag
    // a rate-limited sibling back inside the window it was told to wait out —
    // and every losing attempt is one of only three the file gets.
    const timers = createManualTimers();
    const store = await uploadStore({
      timers,
      upload: (fileId) =>
        fileId === FILE_A
          ? Promise.reject(new Error("offline"))
          : Promise.reject(uploadRateLimitError(RETRY_AFTER_MS)),
      onPublishRetryDue: () => undefined,
    });

    await store.publish([imageFile(FILE_A), imageFile(FILE_B)]);

    expect(timers.nextDueAt).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
    store.destroy();
  });

  it("is not re-attempted by an ordinary scene flush inside the window", async () => {
    // The timer is not the only way back in: `publishLocalAssets` re-offers the
    // whole current file set on every scene flush, so a user who simply keeps
    // drawing would re-attempt inside the window without a per-file deadline.
    const timers = createManualTimers();
    let uploads = 0;
    const store = await uploadStore({
      timers,
      upload: () => {
        uploads += 1;
        return Promise.reject(uploadRateLimitError(RETRY_AFTER_MS));
      },
    });
    const file = imageFile(FILE_A);

    await store.publish([file]);
    expect(uploads).toBe(1);

    // Three more flushes, all inside the window.
    for (let flush = 0; flush < 3; flush += 1) {
      timers.advance(1_000);
      await store.publish([file]);
    }
    expect(uploads).toBe(1);

    timers.advance(RETRY_AFTER_MS);
    await store.publish([file]);
    expect(uploads).toBe(2);
    store.destroy();
  });

  it("spends no attempt on a flush it skipped, so the file is not abandoned", async () => {
    const timers = createManualTimers();
    let uploads = 0;
    const unavailable: string[] = [];
    const store = await uploadStore({
      timers,
      upload: () => {
        uploads += 1;
        return Promise.reject(uploadRateLimitError(RETRY_AFTER_MS));
      },
      onAssetsUnavailable: (fileIds) => unavailable.push(...fileIds),
    });
    const file = imageFile(FILE_A);

    // Enough flushes inside the window to exhaust MAX_PUBLISH_ATTEMPTS if a
    // skipped flush counted as a losing attempt.
    await store.publish([file]);
    for (let flush = 0; flush < 5; flush += 1) {
      timers.advance(1_000);
      await store.publish([file]);
    }
    expect(uploads).toBe(1);
    expect(unavailable).toEqual([]);

    // The budget is preserved rather than removed: three *real* attempts, each
    // after its own window, still end in the file being given up on.
    for (let round = 0; round < 2; round += 1) {
      timers.advance(RETRY_AFTER_MS + 1_000);
      await store.publish([file]);
    }
    expect(uploads).toBe(3);
    expect(unavailable).toEqual([FILE_A]);
    store.destroy();
  });
});
