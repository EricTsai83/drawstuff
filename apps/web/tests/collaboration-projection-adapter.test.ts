import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
vi.mock("server-only", () => ({}));
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";
import {
  applyRoomProjection,
  listProjectedRooms,
} from "@/server/collab/authority-projection";
import { applyStorageFence } from "@/server/collab/authority-storage";
import { openTestDatabase } from "./support/pglite-db";
import { adapterFixture } from "./support/authority-adapter-fixtures";
const testDb = openTestDatabase();
const db = testDb as unknown as Database;
describe("monotonic room projections", () => {
  it("handles duplicate, reordered, revoked and re-granted membership without changing the storage fence", async () => {
    const f = await adapterFixture(db);
    await applyStorageFence(db, f.fence(5));
    expect(await applyRoomProjection(db, f.projection())).toEqual({
      applied: true,
    });
    expect(await applyRoomProjection(db, f.projection())).toEqual({
      applied: false,
    });
    await applyRoomProjection(
      db,
      f.projection({ version: 4, role: "viewer", tombstone: true }),
    );
    expect(await applyRoomProjection(db, f.projection({ version: 3 }))).toEqual(
      { applied: false },
    );
    expect((await listProjectedRooms(db, f.guest)).rooms).toEqual([]);
    await applyRoomProjection(
      db,
      f.projection({ version: 5, role: "viewer", listedAt: 500 }),
    );
    const result = await listProjectedRooms(db, f.guest);
    expect(result.rooms).toMatchObject([
      { roomId: f.roomId, role: "viewer", listedAt: 100 },
    ]);
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({
      authorityEpoch: 5,
      storageState: "ready",
      storageGeneration: 1,
    });
  });
  it("does not recreate projections after account/room deletion, and permanently protects ended rooms", async () => {
    const f = await adapterFixture(db);
    await applyRoomProjection(db, f.projection());
    await testDb.delete(schema.user).where(eq(schema.user.id, f.guest));
    expect(await applyRoomProjection(db, f.projection({ version: 3 }))).toEqual(
      { applied: false },
    );
    expect(
      await testDb.query.collaborationProjectionTombstone.findFirst({
        where: eq(schema.collaborationProjectionTombstone.subject, f.guest),
      }),
    ).toMatchObject({ version: 3 });
    await applyRoomProjection(
      db,
      f.projection({
        subject: f.owner,
        role: "owner",
        version: 4,
        status: "ended",
        tombstone: true,
      }),
    );
    expect(
      await applyRoomProjection(
        db,
        f.projection({ subject: f.owner, version: 5 }),
      ),
    ).toEqual({ applied: false });
    await testDb
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    expect(
      await applyRoomProjection(
        db,
        f.projection({ subject: f.owner, version: 6 }),
      ),
    ).toEqual({ applied: false });
  });
  it("refuses frozen account projections and paginates independent rooms stably when labels change", async () => {
    const f = await adapterFixture(db);
    for (const roomId of ["page-a", "page-b", "page-c"]) {
      await testDb
        .insert(schema.collaborationRoom)
        .values({ roomId, ownerId: f.owner, status: "ready" });
      await applyRoomProjection(
        db,
        f.projection({ roomId: roomIdSchema.parse(roomId) }),
      );
    }
    const first = await listProjectedRooms(db, f.guest, { limit: 2 });
    expect(first.rooms.map((row) => row.roomId)).toEqual(["page-c", "page-b"]);
    await applyRoomProjection(
      db,
      f.projection({
        roomId: roomIdSchema.parse("page-c"),
        version: 3,
        label: "Changed",
        listedAt: 900,
      }),
    );
    const next = await listProjectedRooms(db, f.guest, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next.rooms.map((row) => row.roomId)).toEqual(["page-a"]);
    expect(next.rooms[0]?.sceneId).toBeNull();
    await testDb.insert(schema.collaborationLifecycleSubject).values({
      scope: `account:${f.guest}`,
      kind: "account",
      subject: f.guest,
      frozen: true,
    });
    expect(
      await applyRoomProjection(db, f.projection({ version: 10 })),
    ).toEqual({ applied: false });
    expect((await listProjectedRooms(db, f.guest)).rooms).toEqual([]);
    expect(
      await applyRoomProjection(
        db,
        f.projection({
          roomId: roomIdSchema.parse("page-a"),
          version: 11,
          tombstone: true,
        }),
      ),
    ).toEqual({ applied: true });
  });
});
