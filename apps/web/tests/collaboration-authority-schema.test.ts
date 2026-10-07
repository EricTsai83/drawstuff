import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { openTestDatabase } from "./support/pglite-db";

const db = openTestDatabase();
const owner = "authority-schema-owner";
beforeAll(async () => {
  await db
    .insert(schema.user)
    .values({ id: owner, name: "Owner", email: "schema-owner@example.com" });
});

describe("P1 PostgreSQL authority schema", () => {
  it("permits multiple independent initializing rooms and preserves the optional scene uniqueness rule", async () => {
    await db.insert(schema.collaborationRoom).values([
      { roomId: "independent-a", ownerId: owner, sceneId: null },
      { roomId: "independent-b", ownerId: owner, sceneId: null },
    ]);
    const independent = await db.query.collaborationRoom.findFirst({
      where: eq(schema.collaborationRoom.roomId, "independent-a"),
    });
    expect(independent).toMatchObject({
      sceneId: null,
      status: "initializing",
      authorityEpoch: 1,
    });
    expect(independent).not.toHaveProperty("expiresAt");
    const [scene] = await db
      .insert(schema.scene)
      .values({ userId: owner, name: "Personal source" })
      .returning();
    if (!scene) throw new Error("missing-scene");
    await db
      .insert(schema.collaborationRoom)
      .values({ roomId: "linked-a", ownerId: owner, sceneId: scene.id });
    await expect(
      db.insert(schema.collaborationRoom).values({
        roomId: "linked-b",
        ownerId: owner,
        sceneId: scene.id,
        status: "ready",
      }),
    ).rejects.toThrow();
    await db
      .update(schema.collaborationRoom)
      .set({ status: "ended" })
      .where(eq(schema.collaborationRoom.roomId, "linked-a"));
    await db.insert(schema.collaborationRoom).values({
      roomId: "linked-b",
      ownerId: owner,
      sceneId: scene.id,
      status: "ready",
    });
    await db.delete(schema.scene).where(eq(schema.scene.id, scene.id));
    expect(
      await db.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, "independent-a"),
      }),
    ).toBeDefined();
    expect(
      await db.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, "linked-b"),
      }),
    ).toBeUndefined();
  });

  it("rejects inconsistent operation results, invalid versions and checksum metadata", async () => {
    await db
      .insert(schema.collaborationRoom)
      .values({ roomId: "operations", ownerId: owner });
    const operation = {
      operationId: crypto.randomUUID(),
      roomId: "operations",
      actor: owner,
      kind: "snapshot-put",
      authorityEpoch: 1,
      authGeneration: 1,
      expectedRevision: 0,
      checksum: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      deadline: new Date(Date.now() + 60_000),
      status: "written",
      revision: 1,
      terminalAt: new Date(),
    };
    await db.insert(schema.collaborationOperation).values(operation);
    await expect(
      db.insert(schema.collaborationOperation).values({
        ...operation,
        operationId: crypto.randomUUID(),
        revision: null,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.collaborationOperation).values({
        ...operation,
        operationId: crypto.randomUUID(),
        status: "cancelled",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.collaborationOperation).values({
        ...operation,
        operationId: crypto.randomUUID(),
        authorityEpoch: 0,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.collaborationOperation).values({
        ...operation,
        operationId: crypto.randomUUID(),
        checksum: "plaintext",
      }),
    ).rejects.toThrow();
    await db
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, "operations"));
    expect(await db.select().from(schema.collaborationOperation)).toEqual([]);
    expect(
      await db.query.user.findFirst({ where: eq(schema.user.id, owner) }),
    ).toBeDefined();
  });

  it("registers creating rooms without a scene or room row and keeps terminal fences after account deletion", async () => {
    const subject = "retiring-account";
    await db
      .insert(schema.user)
      .values({ id: subject, name: "Retiring", email: "retiring@example.com" });
    await db.insert(schema.collaborationLifecycleSubject).values({
      scope: `account:${subject}`,
      kind: "account",
      subject,
      version: 2,
      frozen: true,
      retired: true,
    });
    await db.insert(schema.collaborationLifecycleRegistration).values({
      subject,
      roomId: "not-yet-created",
      sceneId: null,
      owner: true,
      lifecycleVersion: 1,
      operationId: crypto.randomUUID(),
    });
    await db
      .insert(schema.collaborationProjectionTombstone)
      .values({ roomId: "not-yet-created", subject, version: 5 });
    await db.delete(schema.user).where(eq(schema.user.id, subject));
    expect(
      await db.query.collaborationLifecycleSubject.findFirst({
        where: eq(schema.collaborationLifecycleSubject.subject, subject),
      }),
    ).toMatchObject({ version: 2, retired: true });
    expect(
      await db.query.collaborationProjectionTombstone.findFirst({
        where: eq(schema.collaborationProjectionTombstone.subject, subject),
      }),
    ).toMatchObject({ version: 5 });
    await expect(
      db.insert(schema.collaborationLifecycleSubject).values({
        scope: "account:invalid",
        kind: "account",
        subject: "invalid",
        retired: true,
        frozen: false,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.collaborationLifecycleSubject).values({
        scope: "scene:invalid",
        kind: "scene",
        subject: "invalid",
        sceneId: null,
      }),
    ).rejects.toThrow();
  });
});
