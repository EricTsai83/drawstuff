/* eslint-disable drizzle/enforce-delete-with-where -- isolated disposable test database */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq } from "drizzle-orm";
import { lifecyclePageSchema } from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { Database } from "@/server/collab/rooms";
import {
  applyLifecycleAdapter,
  retirementIntent,
} from "@/server/collab/authority-lifecycle";
import { registerAuthorityCommand } from "@/server/collab/authority-registration";
import { retireAccount, retireScene } from "@/server/admin/retirement";
import * as schema from "@/server/db/schema";
import { openTestDatabase } from "./support/pglite-db";
const gateway = vi.hoisted(() => vi.fn());
vi.mock("@/server/collab/lifecycle-gateway", () => ({
  callLifecycleGateway: gateway,
}));
const db = openTestDatabase();
const database = db as unknown as Database;
beforeEach(async () => {
  gateway.mockReset();
  await db.delete(schema.collaborationLifecycleSubject);
  await db.delete(schema.collaborationLifecycleRegistration);
  await db.delete(schema.deferredFileCleanup);
  await db.delete(schema.user);
  await db.insert(schema.user).values([
    {
      id: "owner",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
    },
    {
      id: "guest",
      name: "Guest",
      email: "guest@example.com",
      emailVerified: true,
    },
  ]);
});
async function sceneFixture() {
  const [source] = await db
    .insert(schema.scene)
    .values({
      userId: "owner",
      name: "Source",
      thumbnailFileKey: "personal-thumbnail",
    })
    .returning();
  return source!;
}
describe("Lifecycle storage barriers", () => {
  it("freezes idempotently, refuses a different intent, and closes preregistration before enumeration", async () => {
    const source = await sceneFixture();
    const command = await retirementIntent(
      database,
      { kind: "scene", subject: "owner", sceneId: source.id },
      "owner",
    );
    expect(await retirementIntent(database, command.target, "admin")).toEqual(
      command,
    );
    expect(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-freeze",
        command,
      }),
    ).toEqual({ version: 2 });
    expect(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-freeze",
        command,
      }),
    ).toEqual({ version: 2 });
    await expect(
      applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-freeze",
        command: { ...command, operationId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("operation-mismatch");
    await expect(
      registerAuthorityCommand(database, {
        v: 1,
        action: "register",
        roomId: roomIdSchema.parse("late-room"),
        operationId: crypto.randomUUID(),
        identity: {
          subject: "owner",
          email: "owner@example.com",
          lifecycleVersion: 1,
        },
        ownerId: "owner",
        sceneId: source.id,
        create: true,
      }),
    ).rejects.toThrow("fence-mismatch");
    expect(await db.select().from(schema.scene)).toHaveLength(1);
  });
  it("enumerates conservative registrations in bounded pages, including a Room without a parent", async () => {
    const target = { kind: "account" as const, subject: "guest" };
    const command = await retirementIntent(database, target, "admin");
    await db.insert(schema.collaborationLifecycleRegistration).values(
      Array.from({ length: 18 }, (_, i) => ({
        subject: "guest",
        roomId: `room-${String(i).padStart(2, "0")}`,
        owner: i === 0,
        lifecycleVersion: 1,
        operationId: crypto.randomUUID(),
        sceneId: null,
      })),
    );
    await db.insert(schema.session).values(
      ["owner", "guest"].map((subject) => ({
        id: `session-${subject}`,
        token: `token-${subject}`,
        userId: subject,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    await applyLifecycleAdapter(database, {
      v: 1,
      action: "lifecycle-freeze",
      command,
    });
    expect(
      (await db.select().from(schema.session)).map((row) => row.userId),
    ).toEqual(["owner"]);
    const first = lifecyclePageSchema.parse(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-list",
        command,
        version: 2,
      }),
    );
    if (!("rooms" in first)) throw new Error("not-page");
    expect(first.rooms).toHaveLength(16);
    expect(first.rooms[0]?.action).toBe("end-room");
    expect(first.rooms[1]?.action).toBe("revoke-member");
    const last = lifecyclePageSchema.parse(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-list",
        command,
        version: 2,
        cursor: first.cursor ? roomIdSchema.parse(first.cursor) : null,
      }),
    );
    if (!("rooms" in last)) throw new Error("not-page");
    expect(last.rooms).toHaveLength(2);
    expect(last.cursor).toBeNull();
  });
  it("requires the same freeze version and atomically retains personal asset cleanup keys with a scene cascade", async () => {
    const source = await sceneFixture();
    const command = await retirementIntent(
      database,
      { kind: "scene", subject: "owner", sceneId: source.id },
      "owner",
    );
    await expect(
      applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-delete",
        command,
        version: 1,
      }),
    ).rejects.toThrow("fence-mismatch");
    await applyLifecycleAdapter(database, {
      v: 1,
      action: "lifecycle-freeze",
      command,
    });
    await expect(
      applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-delete",
        command,
        version: 1,
      }),
    ).rejects.toThrow("fence-mismatch");
    expect(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-delete",
        command,
        version: 2,
      }),
    ).toEqual({ deleted: true });
    expect(
      await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-delete",
        command,
        version: 2,
      }),
    ).toEqual({ deleted: true });
    expect(await db.select().from(schema.scene)).toEqual([]);
    expect(
      (await db.select().from(schema.deferredFileCleanup)).map(
        (row) => row.utFileKey,
      ),
    ).toEqual(["personal-thumbnail"]);
    const [fence] = await db
      .select()
      .from(schema.collaborationLifecycleSubject)
      .where(
        eq(schema.collaborationLifecycleSubject.scope, `scene:${source.id}`),
      );
    expect(fence).toMatchObject({
      frozen: true,
      retired: true,
      operationId: command.operationId,
    });
  });
  it.each(["account", "scene"] as const)(
    "%s retirement leaves no per-person records for the cascaded rooms",
    async (kind) => {
      const source = await sceneFixture();
      const doomed = `retire-${kind}-doomed`;
      const other = `retire-${kind}-other`;
      await db.insert(schema.collaborationRoom).values([
        {
          roomId: doomed,
          ownerId: "owner",
          sceneId: source.id,
          status: "ended",
          storageState: "ended",
        },
        { roomId: other, ownerId: "guest", status: "ready" },
      ]);
      // The guest's traces in the doomed room; the owner's in the guest's room.
      for (const [roomId, subject] of [
        [doomed, "guest"],
        [other, "owner"],
      ] as const) {
        await db.insert(schema.collaborationLifecycleRegistration).values({
          subject,
          roomId,
          owner: false,
          lifecycleVersion: 1,
          operationId: crypto.randomUUID(),
        });
        await db
          .insert(schema.collaborationProjectionTombstone)
          .values({ roomId, subject, version: 2 });
      }
      const command = await retirementIntent(
        database,
        kind === "account"
          ? { kind, subject: "owner" }
          : { kind, subject: "owner", sceneId: source.id },
        "owner",
      );
      const frozen = await applyLifecycleAdapter(database, {
        v: 1,
        action: "lifecycle-freeze",
        command,
      });
      if (!("version" in frozen)) throw new Error("missing-version");
      expect(
        await applyLifecycleAdapter(database, {
          v: 1,
          action: "lifecycle-delete",
          command,
          version: frozen.version,
        }),
      ).toEqual({ deleted: true });
      const left = async (roomId: string) => ({
        registrations: (
          await db
            .select()
            .from(schema.collaborationLifecycleRegistration)
            .where(eq(schema.collaborationLifecycleRegistration.roomId, roomId))
        ).map((row) => row.subject),
        tombstones: (
          await db
            .select()
            .from(schema.collaborationProjectionTombstone)
            .where(eq(schema.collaborationProjectionTombstone.roomId, roomId))
        ).map((row) => row.subject),
      });
      expect(await left(doomed)).toEqual({ registrations: [], tombstones: [] });
      // Only account retirement removes the account's traces elsewhere.
      expect(await left(other)).toEqual(
        kind === "account"
          ? { registrations: [], tombstones: [] }
          : { registrations: ["owner"], tombstones: ["owner"] },
      );
    },
  );
  it("authorized entry points retain one intent across lost replies and never cascade on a pending response", async () => {
    const source = await sceneFixture();
    gateway.mockRejectedValueOnce(new Error("lost-reply"));
    await expect(
      retireScene({ db: database, sceneId: source.id, ownerUserId: "guest" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(gateway).not.toHaveBeenCalled();
    await expect(
      retireScene({ db: database, sceneId: source.id, ownerUserId: "owner" }),
    ).rejects.toThrow("lost-reply");
    gateway.mockImplementation(
      async (input: { command: { operationId: string } }) => ({
        operationId: input.command.operationId,
        phase: "enforcing",
        version: 2,
      }),
    );
    const result = await retireScene({
      db: database,
      sceneId: source.id,
      ownerUserId: "owner",
    });
    expect(result.enforcement).toBe("pending");
    expect(gateway.mock.calls[0]?.[0]).toEqual(gateway.mock.calls[1]?.[0]);
    expect(await db.select().from(schema.scene)).toHaveLength(1);
    const account = await retireAccount({ db: database, userId: "guest" });
    expect(account.enforcement).toBe("pending");
    expect(await db.select().from(schema.user)).toHaveLength(2);
  });
});
