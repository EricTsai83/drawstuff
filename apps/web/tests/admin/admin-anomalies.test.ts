// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { gatewayCalls } = vi.hoisted(() => ({
  gatewayCalls: [] as unknown[],
}));
vi.mock("@/server/collab/lifecycle-gateway", () => ({
  callLifecycleGateway: (input: {
    action: string;
    command?: { operationId: string };
  }) => {
    gatewayCalls.push(input);
    if (input.action !== "begin" || !input.command)
      throw new Error("unexpected");
    return Promise.resolve({
      operationId: input.command.operationId,
      phase: "deleting",
      version: 2,
    });
  },
}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));
const { envDouble } = vi.hoisted(() => ({
  envDouble: {
    COLLAB_CONTROL_URL: "http://127.0.0.1:3105",
    COLLAB_ROOMS_DISABLED: undefined as string | undefined,
  },
}));
vi.mock("@/env", () => ({ env: envDouble }));

const { pgClient, testDb } = await vi.hoisted(async () => {
  const { createTestDatabase } = await import("../support/pglite-db");
  return createTestDatabase();
});

vi.mock("@/server/db/index", () => ({ db: testDb }));

import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { registerTestDatabase } from "../support/pglite-db";
import { testCaller } from "../support/trpc-caller";

registerTestDatabase({ pgClient, testDb });

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const ago = (ms: number) => new Date(Date.now() - ms);
const admin = () => testCaller(testDb, "admin-user").admin;

beforeEach(async () => {
  gatewayCalls.length = 0;
  await testDb.delete(schema.adminAuditEvent);
  await testDb.delete(schema.collaborationLifecycleSubject);
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.adminGrant);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: "admin-user", name: "Admin", email: "admin@example.com" },
    { id: "owner", name: "Owner", email: "owner@example.com" },
  ]);
  await testDb.insert(schema.adminGrant).values({
    userId: "admin-user",
    role: "operator",
    grantSource: "bootstrap",
  });
});

const room = (
  roomId: string,
  values: Partial<typeof schema.collaborationRoom.$inferInsert>,
) =>
  testDb
    .insert(schema.collaborationRoom)
    .values({ roomId, ownerId: "owner", ...values });

describe("admin anomalies", () => {
  it("lists each anomaly only once it passes its threshold", async () => {
    const operationId = crypto.randomUUID();
    await testDb.insert(schema.collaborationLifecycleSubject).values([
      {
        scope: "account:stuck",
        kind: "account",
        subject: "stuck",
        frozen: true,
        frozenAt: ago(HOUR_MS + 1_000),
        operationId,
      },
      // Frozen before `frozen_at` was recorded: old by definition.
      {
        scope: "account:legacy",
        kind: "account",
        subject: "legacy",
        frozen: true,
      },
      {
        scope: "account:fresh",
        kind: "account",
        subject: "fresh",
        frozen: true,
        frozenAt: ago(10 * 60_000),
      },
      {
        scope: "account:done",
        kind: "account",
        subject: "done",
        frozen: true,
        retired: true,
        frozenAt: ago(DAY_MS),
      },
    ]);
    await room("room-open-old", {
      status: "ended",
      storageState: "ready",
      endedAt: ago(HOUR_MS + 1_000),
    });
    await room("room-open-new", {
      status: "ended",
      storageState: "ready",
      endedAt: ago(10 * 60_000),
    });
    await room("room-init-old", {
      status: "initializing",
      initializationDeadline: ago(16 * 60_000),
    });
    await room("room-init-new", {
      status: "initializing",
      initializationDeadline: ago(5 * 60_000),
    });
    await room("room-data-old", {
      status: "ended",
      storageState: "ended",
      endedAt: ago(9 * DAY_MS),
      label: "left behind",
    });
    await room("room-data-new", {
      status: "ended",
      storageState: "ended",
      endedAt: ago(7.5 * DAY_MS),
      label: "within grace",
    });
    await testDb.insert(schema.deferredFileCleanup).values({
      utFileKey: "failed-key",
      reason: "t",
      status: "failed",
    });

    const result = await admin().anomalies();

    expect(result.stuckRetirements.count).toBe(2);
    expect(
      result.stuckRetirements.items.map((item) => item.scope).sort(),
    ).toEqual(["account:legacy", "account:stuck"]);
    expect(result.unclosedStorage.items.map((r) => r.roomId)).toEqual([
      "room-open-old",
    ]);
    expect(result.stuckInitializing.items.map((r) => r.roomId)).toEqual([
      "room-init-old",
    ]);
    expect(result.endedWithData.items.map((r) => r.roomId)).toEqual([
      "room-data-old",
    ]);
    expect(result.failedCleanup.count).toBe(1);

    await expect(
      testCaller(testDb, "owner").admin.anomalies(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("resumes a stuck retirement with its recorded operation", async () => {
    const operationId = crypto.randomUUID();
    const sceneId = crypto.randomUUID();
    await testDb.insert(schema.collaborationLifecycleSubject).values({
      scope: `scene:${sceneId}`,
      kind: "scene",
      subject: "owner",
      sceneId,
      frozen: true,
      operationId,
    });

    await expect(
      admin().resumeRetirement({ scope: `scene:${sceneId}` }),
    ).resolves.toMatchObject({
      found: true,
      operationId,
      enforcement: "pending",
    });
    expect(gatewayCalls).toEqual([
      {
        action: "begin",
        command: {
          v: 1,
          operationId,
          actor: "owner",
          target: { kind: "scene", subject: "owner", sceneId },
        },
      },
    ]);

    await testDb
      .update(schema.collaborationLifecycleSubject)
      .set({ retired: true });
    await expect(
      admin().resumeRetirement({ scope: `scene:${sceneId}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await testDb
        .select({
          action: schema.adminAuditEvent.action,
          status: schema.adminAuditEvent.status,
        })
        .from(schema.adminAuditEvent),
    ).toEqual(
      expect.arrayContaining([
        { action: "resume-retirement", status: "succeeded" },
        { action: "resume-retirement", status: "failed" },
      ]),
    );
  });

  it("closes an ended room's storage with the fence it never received", async () => {
    await room("room-open", {
      status: "ended",
      storageState: "ready",
      authorityEpoch: 3,
      endedAt: ago(2 * HOUR_MS),
    });
    await room("room-live", { status: "ready", storageState: "ready" });

    await expect(
      admin().closeRoomStorage({ roomId: "room-open" }),
    ).resolves.toEqual({ found: true, closed: true });
    const closed = await testDb.query.collaborationRoom.findFirst({
      where: eq(schema.collaborationRoom.roomId, "room-open"),
    });
    expect(closed).toMatchObject({ storageState: "ended", authorityEpoch: 3 });

    // Never closes a live room, and is a no-op once closed.
    await expect(
      admin().closeRoomStorage({ roomId: "room-live" }),
    ).resolves.toEqual({ found: true, closed: false });
    await expect(
      admin().closeRoomStorage({ roomId: "room-open" }),
    ).resolves.toEqual({ found: true, closed: false });
    expect((await admin().anomalies()).unclosedStorage.count).toBe(0);
  });

  it("runs one room-retention pass that clears ended rooms still holding data", async () => {
    await room("room-data", {
      status: "ended",
      storageState: "ended",
      endedAt: ago(9 * DAY_MS),
      label: "left behind",
    });

    await expect(admin().runRoomRetention()).resolves.toMatchObject({
      roomsReclaimed: 1,
    });
    expect((await admin().anomalies()).endedWithData.count).toBe(0);
    const [audit] = await testDb.select().from(schema.adminAuditEvent);
    expect(audit).toMatchObject({
      action: "run-room-retention",
      targetType: "maintenance",
      status: "succeeded",
    });
  });

  it("reports recent runs, the cleanup backlog, and Worker health", async () => {
    await testDb.delete(schema.maintenanceRun);
    await testDb.insert(schema.maintenanceRun).values({
      trigger: "cron",
      status: "failed",
      failedJobs: 1,
      startedAt: ago(HOUR_MS),
      report: JSON.stringify({
        failed: 1,
        jobs: [
          {
            name: "drain-cleanup-queue",
            status: "ok",
            detail: { remaining: 3 },
          },
          { name: "record-retention", status: "error", error: "boom" },
        ],
      }),
    });
    await testDb.insert(schema.deferredFileCleanup).values([
      { utFileKey: "a", reason: "delete-user", nextAttemptAt: ago(1_000) },
      { utFileKey: "b", reason: "delete-user", nextAttemptAt: ago(-HOUR_MS) },
      { utFileKey: "c", reason: "replace-thumbnail" },
    ]);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          ok: true,
          version: { id: "v-123", tag: "" },
          ready: { roomTokenSecret: true, allowedOrigins: true },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const status = await admin().maintenanceStatus();
      expect(status.runs[0]).toMatchObject({
        trigger: "cron",
        status: "failed",
        jobs: [
          { name: "drain-cleanup-queue", detail: { remaining: 3 } },
          { name: "record-retention", status: "error", error: "boom" },
        ],
      });
      expect(status.backlog).toMatchObject({ pending: 3, due: 2 });
      expect(status.backlog.byReason[0]).toMatchObject({
        reason: "delete-user",
        count: 2,
      });
      expect(status.health).toMatchObject({ reachable: true, ok: true });

      fetchMock.mockImplementation(() =>
        Promise.reject(new TypeError("fetch failed")),
      );
      expect((await admin().maintenanceStatus()).health).toEqual({
        reachable: false,
        error: "TypeError",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns collaboration off and on at runtime, under the env override", async () => {
    const { collaborationRoomsDisabled } =
      await import("@/server/collab/relay-routing");
    await testDb.delete(schema.opsSetting);
    expect(await collaborationRoomsDisabled()).toBe(false);

    await expect(
      admin().setCollabRoomsDisabled({ disabled: true }),
    ).resolves.toEqual({ disabled: true });
    expect(await collaborationRoomsDisabled()).toBe(true);
    expect((await admin().opsControls()).collabRoomsDisabled).toMatchObject({
      on: true,
      envOverride: false,
      updatedBy: "admin-user",
    });

    await admin().setCollabRoomsDisabled({ disabled: false });
    expect(await collaborationRoomsDisabled()).toBe(false);

    // The env break-glass wins over the runtime switch.
    envDouble.COLLAB_ROOMS_DISABLED = "1";
    try {
      expect(await collaborationRoomsDisabled()).toBe(true);
      expect(
        (await admin().opsControls()).collabRoomsDisabled.envOverride,
      ).toBe(true);
    } finally {
      envDouble.COLLAB_ROOMS_DISABLED = undefined;
    }
    const actions = (await testDb.select().from(schema.adminAuditEvent)).map(
      (event) => event.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["disable-collaboration", "enable-collaboration"]),
    );
  });

  it("counts log-only signals with a per-instance throttle and resets them", async () => {
    const { recordOpsSignal } = await import("@/server/ops/settings");
    await testDb.delete(schema.opsSignal);
    await recordOpsSignal("ratelimit.degraded:join");
    // Within the throttle window: counted locally, not written.
    await recordOpsSignal("ratelimit.degraded:join");
    const [first] = (await admin().opsControls()).signals;
    expect(first).toMatchObject({ name: "ratelimit.degraded:join", count: 1 });

    await expect(admin().resetOpsSignals()).resolves.toEqual({ reset: 1 });
    expect((await admin().opsControls()).signals).toEqual([]);
  });
});
