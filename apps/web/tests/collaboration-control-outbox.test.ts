// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The outbox's own mechanics: transactional enqueue, dispatch bookkeeping,
 * bounded drain with claim leases, poison handling and retention. The DO
 * dispatcher's HTTP contract is covered by its own suite.
 */
const { dispatchState } = vi.hoisted(() => ({
  dispatchState: {
    doCalls: [] as unknown[],
    doResult: { enforced: true, closedSessions: 1 } as unknown,
    doThrows: false,
    /** When set, DO dispatches block until this promise resolves. */
    doGate: null as Promise<void> | null,
  },
}));
vi.mock("@/server/collab/do-control", () => ({
  pushDoRoomControl: async (params: unknown) => {
    dispatchState.doCalls.push(params);
    if (dispatchState.doGate) await dispatchState.doGate;
    if (dispatchState.doThrows) throw new Error("dispatcher exploded");
    return dispatchState.doResult;
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import {
  backoffDelayMs,
  CLAIM_LEASE_MS,
  dispatchControlOutboxEvent,
  drainControlOutbox,
  enqueueRoomControlEvent,
  MAX_CONTROL_OUTBOX_ATTEMPTS,
  purgeControlOutboxRows,
  type ControlOutboxEvent,
} from "@/server/collab/control-outbox";
import type { Database } from "@/server/collab/rooms";
import * as schema from "@/server/db/schema";

const client = new PGlite();
const rawDb = drizzle(client, { schema });
// The outbox API is typed against the app's postgres-js database; the PGlite
// double satisfies the same Drizzle surface.
const testDb = rawDb as unknown as Database;

const outboxRows = () =>
  rawDb.select().from(schema.collaborationControlOutbox);

const rowOf = async (eventId: string) => {
  const rows = await rawDb
    .select()
    .from(schema.collaborationControlOutbox)
    .where(eq(schema.collaborationControlOutbox.eventId, eventId));
  return rows[0];
};

const enqueue = (
  overrides: Partial<{
    roomId: string;
    authRevision: number;
    now: Date;
  }> = {},
): Promise<ControlOutboxEvent> =>
  enqueueRoomControlEvent(testDb, {
    roomId: overrides.roomId ?? "room-outbox-test-0001",
    authGeneration: 1,
    authRevision: overrides.authRevision ?? 2,
    action: "revoke-member",
    subjectUserId: "user-guest",
    now: overrides.now ?? new Date(),
  });

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  dispatchState.doCalls.length = 0;
  dispatchState.doResult = { enforced: true, closedSessions: 1 };
  dispatchState.doThrows = false;
  dispatchState.doGate = null;
  await testDb.delete(schema.collaborationControlOutbox);
});

describe("transactional enqueue", () => {
  it("commits the intent with the mutation and rolls it back with it", async () => {
    // Committed path.
    await testDb.transaction(async (tx) => {
      await enqueueRoomControlEvent(tx, {
        roomId: "room-committed-000000",
        authGeneration: 1,
        authRevision: 2,
        action: "end-room",
        now: new Date(),
      });
    });
    expect(await outboxRows()).toHaveLength(1);

    // A mutation that fails after enqueuing must take the intent with it:
    // an event for an authorization change that never committed would close
    // sockets the database still admits.
    await expect(
      testDb.transaction(async (tx) => {
        await enqueueRoomControlEvent(tx, {
          roomId: "room-rolled-back-0000",
          authGeneration: 1,
          authRevision: 3,
          action: "end-room",
          now: new Date(),
        });
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect(await outboxRows()).toHaveLength(1);
  });

  it("stores the minimal intent and never a signed token", async () => {
    const event = await enqueue();
    expect(event).toMatchObject({
      action: "revoke-member",
      subjectUserId: "user-guest",
      status: "pending",
      attempts: 0,
      lastFailure: null,
      deliveredAt: null,
    });
    // Closed schema: nothing token-shaped is persisted; every delivery signs
    // a fresh short-lived control token instead.
    expect(Object.keys(event)).toEqual([
      "eventId",
      "roomId",
      "authGeneration",
      "authRevision",
      "action",
      "subjectUserId",
      "attempts",
      "nextAttemptAt",
      "status",
      "lastFailure",
      "deliveredAt",
      "createdAt",
      "updatedAt",
    ]);
  });
});

describe("dispatch bookkeeping", () => {
  it("marks a successful delivery through the DO gateway", async () => {
    const event = await enqueue();
    const result = await dispatchControlOutboxEvent(testDb, event);
    expect(result).toMatchObject({ enforced: true });
    expect(dispatchState.doCalls).toHaveLength(1);
    expect(await rowOf(event.eventId)).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastFailure: null,
    });
  });

  it("keeps a failed delivery pending with backoff and the closed failure reason", async () => {
    dispatchState.doResult = {
      enforced: false,
      failure: "timeout",
      reason: "aborted after 3000ms",
    };
    const now = new Date();
    const event = await enqueue({ now });
    await dispatchControlOutboxEvent(testDb, event, now);
    const row = await rowOf(event.eventId);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lastFailure: "timeout",
    });
    // Jittered exponential backoff: strictly in the future, bounded by the
    // formula so the minute-level cron picks it up on a later run.
    const delay = row!.nextAttemptAt.getTime() - now.getTime();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(backoffDelayMs(1, () => 1));
  });

  it("moves an event to the terminal failed state after the attempt cap", async () => {
    dispatchState.doResult = {
      enforced: false,
      failure: "rejected",
      reason: "relay responded 500",
    };
    const event = await enqueue();
    await testDb
      .update(schema.collaborationControlOutbox)
      .set({ attempts: MAX_CONTROL_OUTBOX_ATTEMPTS - 1 })
      .where(eq(schema.collaborationControlOutbox.eventId, event.eventId));
    await dispatchControlOutboxEvent(testDb, {
      ...event,
      attempts: MAX_CONTROL_OUTBOX_ATTEMPTS - 1,
    });
    expect(await rowOf(event.eventId)).toMatchObject({
      status: "failed",
      attempts: MAX_CONTROL_OUTBOX_ATTEMPTS,
      lastFailure: "rejected",
    });
    // Terminal: a later drain never claims it again.
    const report = await drainControlOutbox({ db: testDb });
    expect(report.claimed).toBe(0);
  });

  it("computes capped exponential backoff", () => {
    expect(backoffDelayMs(1, () => 0.5)).toBe(5_000);
    expect(backoffDelayMs(2, () => 0.5)).toBe(10_000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(20_000);
    // Jitter bounds: ±25%.
    expect(backoffDelayMs(1, () => 0)).toBe(3_750);
    expect(backoffDelayMs(1, () => 1)).toBe(6_250);
    // Cap.
    expect(backoffDelayMs(20, () => 0.5)).toBe(600_000);
  });
});

describe("bounded drain", () => {
  it("claims only due events, respects the cap, and reports the leftovers", async () => {
    const now = new Date();
    await enqueue({ roomId: "room-due-a-0000000000", now });
    await enqueue({ roomId: "room-due-b-0000000000", now });
    await enqueue({ roomId: "room-due-c-0000000000", now });
    await enqueue({
      roomId: "room-future-0000000000",
      now: new Date(now.getTime() + 60_000),
    });

    const report = await drainControlOutbox({ db: testDb, maxEvents: 2 });
    expect(report).toMatchObject({ claimed: 2, delivered: 2, retried: 0 });
    // One due event was left behind by the cap and stays visible.
    expect(report.remainingDue).toBe(1);
  });

  it("leases claimed events so an overlapping drain cannot double-claim", async () => {
    const event = await enqueue();
    let releaseDispatch!: () => void;
    dispatchState.doGate = new Promise((resolve) => {
      releaseDispatch = resolve;
    });

    // First drainer claims the event and blocks inside the dispatch.
    const firstDrain = drainControlOutbox({ db: testDb });
    await vi.waitFor(async () => {
      const row = await rowOf(event.eventId);
      if (!row || row.nextAttemptAt.getTime() <= Date.now()) {
        throw new Error("not yet claimed");
      }
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now() + CLAIM_LEASE_MS,
      );
    });

    // An overlapping drainer sees the leased (no longer due) row and claims
    // nothing — the lease is what partitions concurrent drainers.
    const overlapping = await drainControlOutbox({ db: testDb });
    expect(overlapping).toMatchObject({ claimed: 0 });

    releaseDispatch();
    expect(await firstDrain).toMatchObject({ claimed: 1, delivered: 1 });

    // A drainer stuck mid-dispatch only holds its lease: the row is due
    // again once the lease window passes, and another drainer recovers it.
    const stuck = await enqueue({ roomId: "room-lease-lapse-0000" });
    let releaseStuck!: () => void;
    dispatchState.doGate = new Promise((resolve) => {
      releaseStuck = resolve;
    });
    const stuckDrain = drainControlOutbox({ db: testDb });
    await vi.waitFor(async () => {
      const row = await rowOf(stuck.eventId);
      if (!row || row.nextAttemptAt.getTime() <= Date.now()) {
        throw new Error("not yet claimed");
      }
    });
    dispatchState.doGate = null;
    const afterLease = new Date(Date.now() + CLAIM_LEASE_MS + 1_000);
    const recovered = await drainControlOutbox({
      db: testDb,
      now: () => afterLease,
    });
    expect(recovered).toMatchObject({ claimed: 1, delivered: 1 });
    // The stale drainer eventually finishes; its duplicate delivery is
    // idempotent and the row stays delivered.
    releaseStuck();
    await stuckDrain;
    expect(await rowOf(stuck.eventId)).toMatchObject({ status: "delivered" });
  });

  it("classifies a throwing dispatcher as a failed attempt that reaches poison", async () => {
    // A dispatcher that throws instead of returning the closed result union
    // must burn an attempt like any other failure — otherwise a
    // deterministic bug would be reclaimed forever and never turn into an
    // observable terminal state.
    dispatchState.doThrows = true;
    const event = await enqueue();
    const first = await drainControlOutbox({ db: testDb });
    expect(first).toMatchObject({ claimed: 1, delivered: 0, retried: 1 });
    expect(await rowOf(event.eventId)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastFailure: "unreachable",
    });

    await testDb
      .update(schema.collaborationControlOutbox)
      .set({
        attempts: MAX_CONTROL_OUTBOX_ATTEMPTS - 1,
        nextAttemptAt: new Date(),
      })
      .where(eq(schema.collaborationControlOutbox.eventId, event.eventId));
    const last = await drainControlOutbox({ db: testDb });
    expect(last).toMatchObject({ claimed: 1, poisoned: 1 });
    expect(await rowOf(event.eventId)).toMatchObject({
      status: "failed",
      attempts: MAX_CONTROL_OUTBOX_ATTEMPTS,
    });
  });

  it("retries a failed delivery on a later run once its backoff elapses", async () => {
    dispatchState.doResult = {
      enforced: false,
      failure: "unreachable",
      reason: "connect ECONNREFUSED",
    };
    const event = await enqueue();
    const first = await drainControlOutbox({ db: testDb });
    expect(first).toMatchObject({ claimed: 1, retried: 1, delivered: 0 });

    dispatchState.doResult = { enforced: true, closedSessions: 1 };
    const afterBackoff = new Date(Date.now() + backoffDelayMs(1, () => 1) + 1);
    const second = await drainControlOutbox({
      db: testDb,
      now: () => afterBackoff,
    });
    expect(second).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await rowOf(event.eventId)).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
  });

});

describe("retention", () => {
  it("purges old terminal rows only, on their own horizons", async () => {
    const now = new Date();
    const DAY_MS = 24 * 60 * 60_000;
    const seed = async (
      status: "pending" | "delivered" | "failed",
      ageDays: number,
      roomId: string,
    ) => {
      const event = await enqueue({ roomId });
      await testDb
        .update(schema.collaborationControlOutbox)
        .set({
          status,
          updatedAt: new Date(now.getTime() - ageDays * DAY_MS),
        })
        .where(eq(schema.collaborationControlOutbox.eventId, event.eventId));
      return event.eventId;
    };
    const deliveredOld = await seed("delivered", 8, "room-delivered-old-00");
    const deliveredNew = await seed("delivered", 6, "room-delivered-new-00");
    const failedOld = await seed("failed", 31, "room-failed-old-00000");
    const failedNew = await seed("failed", 29, "room-failed-new-00000");
    const pendingOld = await seed("pending", 90, "room-pending-old-0000");

    const purged = await purgeControlOutboxRows(testDb, now);
    expect(purged).toBe(2);
    expect(await rowOf(deliveredOld)).toBeUndefined();
    expect(await rowOf(failedOld)).toBeUndefined();
    expect(await rowOf(deliveredNew)).toBeDefined();
    expect(await rowOf(failedNew)).toBeDefined();
    // A pending event is enforcement debt, never garbage: retention must not
    // erase it however old it is.
    expect(await rowOf(pendingOld)).toBeDefined();
  });
});
