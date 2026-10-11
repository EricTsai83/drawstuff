// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as schema from "@/server/db/schema";
import { openTestDatabase } from "../support/pglite-db";
import { testCaller } from "../support/trpc-caller";

const testDb = openTestDatabase();
const OWNER = "owner";
const OTHER = "other";

beforeEach(async () => {
  await testDb.delete(schema.userLastActiveWorkspace);
  await testDb.delete(schema.userDefaultWorkspace);
  await testDb.delete(schema.workspace);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: OTHER, name: "Other", email: "other@example.com" },
  ]);
});

describe("workspace router", () => {
  it("lists workspaces with the default and last-active ids", async () => {
    const caller = testCaller(testDb, OWNER);
    await caller.workspace.ensureDefault();
    const extra = await caller.workspace.create({ name: "Extra" });
    await caller.workspace.setLastActive({ workspaceId: extra.id });

    const listed = await caller.workspace.listWithMeta();

    expect(listed.workspaces.map((w) => w.name)).toEqual([
      "Default workspace",
      "Extra",
    ]);
    expect(listed.defaultWorkspaceId).toBe(listed.workspaces[0]?.id);
    expect(listed.lastActiveWorkspaceId).toBe(extra.id);
    expect(typeof listed.workspaces[0]?.createdAt).toBe("string");
  });

  it("reads and updates only the caller's own workspace", async () => {
    const created = await testCaller(testDb, OWNER).workspace.create({
      name: "Mine",
    });
    const intruder = testCaller(testDb, OTHER);

    await expect(
      intruder.workspace.getOwned({ id: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      intruder.workspace.update({ id: created.id, name: "Stolen" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const updated = await testCaller(testDb, OWNER).workspace.update({
      id: created.id,
      name: "Renamed",
      description: "Notes",
    });
    expect(updated).toMatchObject({ name: "Renamed", description: "Notes" });
    await expect(
      testCaller(testDb, OWNER).workspace.getOwned({ id: created.id }),
    ).resolves.toMatchObject({ name: "Renamed" });
  });
});
