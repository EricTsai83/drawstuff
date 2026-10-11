// @vitest-environment node
import type { LifecycleCommand } from "@drawstuff/collaboration/authority";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The Lifecycle gateway runs the real adapter steps (freeze, then delete);
// Room enforcement (ending owned rooms, withdrawing invitations elsewhere)
// is the Durable Object's part and is covered by its own tests.
vi.mock("@/server/collab/lifecycle-gateway", () => ({
  callLifecycleGateway: async (input: {
    action: string;
    command?: LifecycleCommand;
  }) => {
    if (input.action !== "begin" || !input.command)
      throw new Error("unexpected");
    const { applyLifecycleAdapter } =
      await import("@/server/collab/authority-lifecycle");
    const database = testDb as unknown as Database;
    const frozen = await applyLifecycleAdapter(database, {
      v: 1,
      action: "lifecycle-freeze",
      command: input.command,
    });
    if (!("version" in frozen)) throw new Error("missing-version");
    await applyLifecycleAdapter(database, {
      v: 1,
      action: "lifecycle-delete",
      command: input.command,
      version: frozen.version,
    });
    return {
      operationId: input.command.operationId,
      phase: "completed",
      version: frozen.version,
    };
  },
}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: () => Promise.resolve(),
  rateLimitMetadataOf: () => null,
}));
vi.mock("@/env", () => ({
  env: { COLLAB_CONTROL_URL: "http://127.0.0.1:3105" },
}));

import { eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { retireAccount } from "@/server/admin/retirement";
import type { Database } from "@/server/collab/rooms";
import * as schema from "@/server/db/schema";
import { openTestDatabase } from "./support/pglite-db";

const testDb = openTestDatabase();

const TARGET = "retiring-user";
const TARGET_EMAIL = "retiring@example.com";
const OTHER = "other-user";

/** Columns that hold a user ID anywhere in the schema. */
const USER_COLUMNS = new Set([
  "user_id",
  "owner_id",
  "subject",
  "updated_by",
  "registered_by",
  "actor_user_id",
  "granted_by_user_id",
]);

/**
 * What an account retirement deliberately leaves behind, and why (see the
 * data lifecycle doc): the retired lifecycle record answers a duplicate
 * begin and is purged by record retention 30 days later; audit rows keep
 * naming their actor (no foreign key, 365-day retention).
 */
const RETAINED = new Set([
  "admin_audit_event.actor_user_id",
  "collaboration_lifecycle_subject.subject",
]);

const schemaExports: unknown[] = Object.values(schema);
const tables = schemaExports.filter((value): value is PgTable =>
  is(value, PgTable),
);

/** Every user-ID column still pointing at `userId`, as `table.column`. */
async function references(userId: string): Promise<string[]> {
  const found: string[] = [];
  for (const table of tables) {
    const name = getTableName(table).replace(/^drawstuff_/, "");
    if (name === "user") {
      const [row] = await testDb
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(schema.user.id, userId));
      if (row && row.n > 0) found.push("user.id");
      continue;
    }
    for (const column of Object.values(getTableColumns(table))) {
      if (!USER_COLUMNS.has(column.name)) continue;
      const [row] = await testDb
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(column, userId));
      if (row && row.n > 0) found.push(`${name}.${column.name}`);
    }
  }
  return found.sort();
}

beforeEach(async () => {
  for (const table of tables)
    await testDb.execute(sql.raw(`truncate "${getTableName(table)}" cascade`));
  await testDb.insert(schema.user).values([
    { id: TARGET, name: "Retiring", email: TARGET_EMAIL },
    { id: OTHER, name: "Other", email: "other@example.com" },
  ]);
});

describe("account retirement inventory", () => {
  it("leaves no row pointing at the account except the documented record", async () => {
    const now = new Date();
    await testDb.insert(schema.session).values({
      id: "session",
      token: "token",
      userId: TARGET,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(schema.account).values({
      id: "account",
      accountId: "google-id",
      providerId: "google",
      userId: TARGET,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(schema.personalLibrary).values({
      userId: TARGET,
      compressedData: Buffer.from("x"),
      byteLength: 1,
      checksum: "a".repeat(64),
    });
    const [space] = await testDb
      .insert(schema.workspace)
      .values({ name: "Space", userId: TARGET })
      .returning({ id: schema.workspace.id });
    await testDb
      .insert(schema.userDefaultWorkspace)
      .values({ userId: TARGET, workspaceId: space!.id });
    await testDb
      .insert(schema.userLastActiveWorkspace)
      .values({ userId: TARGET, workspaceId: space!.id });
    const [label] = await testDb
      .insert(schema.category)
      .values({ userId: TARGET, name: "Label" })
      .returning({ id: schema.category.id });
    const [owned] = await testDb
      .insert(schema.scene)
      .values({
        userId: TARGET,
        name: "Owned",
        workspaceId: space!.id,
        thumbnailFileKey: "thumb-key",
      })
      .returning({ id: schema.scene.id });
    await testDb
      .insert(schema.sceneCategory)
      .values({ sceneId: owned!.id, categoryId: label!.id });
    await testDb.insert(schema.fileRecord).values({
      sceneId: owned!.id,
      ownerId: TARGET,
      utFileKey: "scene-image",
      excalidrawFileId: "file-1",
      size: 1,
      url: "https://example.com/scene-image",
    });
    await testDb
      .insert(schema.sharedScene)
      .values({ sharedSceneId: "shared", ownerId: TARGET });
    await testDb.insert(schema.fileRecord).values({
      sharedSceneId: "shared",
      ownerId: TARGET,
      utFileKey: "shared-image",
      excalidrawFileId: "file-2",
      size: 1,
      url: "https://example.com/shared-image",
    });

    // A room the account owns, and another account's room it joined.
    await testDb.insert(schema.collaborationRoom).values([
      { roomId: "room-own", ownerId: TARGET, status: "ready" },
      { roomId: "room-other", ownerId: OTHER, status: "ready" },
    ]);
    await testDb.insert(schema.collaborationRoomMember).values([
      { roomId: "room-own", userId: TARGET, role: "owner", access: "owned" },
      {
        roomId: "room-other",
        userId: TARGET,
        role: "editor",
        access: "invited",
      },
    ]);
    await testDb.insert(schema.collaborationLifecycleRegistration).values(
      ["room-own", "room-other"].map((roomId) => ({
        subject: TARGET,
        roomId,
        owner: roomId === "room-own",
        lifecycleVersion: 1,
        operationId: crypto.randomUUID(),
        sceneId: null,
      })),
    );
    await testDb
      .insert(schema.collaborationProjectionTombstone)
      .values({ roomId: "room-other", subject: TARGET, version: 1 });
    await testDb.insert(schema.collaborationSnapshot).values({
      roomId: "room-other",
      revision: 1,
      data: Buffer.from("s"),
      byteLength: 1,
      checksum: "b".repeat(64),
      updatedBy: TARGET,
    });
    await testDb.insert(schema.collaborationAsset).values({
      roomId: "room-other",
      excalidrawFileId: "a".repeat(40),
      utFileKey: "room-image",
      url: "https://example.com/room-image",
      byteLength: 16,
      registeredBy: TARGET,
    });

    // The account was an administrator, granted access to someone else, and
    // acted in the audit log.
    await testDb.insert(schema.adminGrant).values([
      { userId: TARGET, role: "operator", grantSource: "bootstrap" },
      {
        userId: OTHER,
        role: "operator",
        grantSource: "operator",
        grantedByUserId: TARGET,
      },
    ]);
    await testDb.insert(schema.adminAuditEvent).values({
      actorUserId: TARGET,
      action: "grant-admin",
      targetType: "account",
      targetId: OTHER,
      status: "succeeded",
    });

    expect(await references(TARGET)).not.toEqual([]);

    await expect(
      retireAccount({ db: testDb as unknown as Database, userId: TARGET }),
    ).resolves.toMatchObject({ found: true, enforcement: "enforced" });

    expect(await references(TARGET)).toEqual([...RETAINED].sort());
    // Its own grant cascaded away; the grant it made survives unattributed.
    const grants = await testDb.select().from(schema.adminGrant);
    expect(
      grants.map((grant) => [grant.userId, grant.grantedByUserId]),
    ).toEqual([[OTHER, null]]);
    const [subject] = await testDb
      .select()
      .from(schema.collaborationLifecycleSubject)
      .where(
        eq(schema.collaborationLifecycleSubject.scope, `account:${TARGET}`),
      );
    expect(subject).toMatchObject({ frozen: true, retired: true });

    // Everything the account owned in storage is queued for deletion; the
    // image it added to someone else's room stays with that room.
    const queued = await testDb.select().from(schema.deferredFileCleanup);
    expect(queued.map((task) => task.utFileKey).sort()).toEqual([
      "scene-image",
      "shared-image",
      "thumb-key",
    ]);
    // The other account's room and its content are untouched.
    const [otherRoom] = await testDb
      .select()
      .from(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, "room-other"));
    expect(otherRoom).toMatchObject({ status: "ready" });
  });
});
