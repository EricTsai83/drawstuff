import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
vi.mock("server-only", () => ({}));
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/collab/rooms";
import {
  applyInviteProjection,
  applyRoomProjection,
  listProjectedRooms,
} from "@/server/collab/authority-projection";
import {
  applyStorageFence,
  cleanupAdapterRoom,
} from "@/server/collab/authority-storage";
import { openTestDatabase } from "./support/pglite-db";
import {
  NO_ROOM_RECORDS,
  adapterFixture,
  endedRoomRecords,
} from "./support/authority-adapter-fixtures";
const testDb = openTestDatabase();
const db = testDb as unknown as Database;
type Fixture = Awaited<ReturnType<typeof adapterFixture>>;
/** The guest's room list; `email` is its verified address, or null. */
const listGuest = (
  f: Fixture,
  input: object = {},
  email: string | null = null,
) => listProjectedRooms(db, { subject: f.guest, email }, input);
const guestEmail = (f: Fixture) => `${f.guest}@example.com`;
async function addRoom(f: Fixture, id: string) {
  const roomId = roomIdSchema.parse(id);
  await testDb
    .insert(schema.collaborationRoom)
    .values({ roomId, ownerId: f.owner, status: "ready" });
  return roomId;
}
const memberRow = (f: Fixture) =>
  testDb.query.collaborationRoomMember.findFirst({
    where: and(
      eq(schema.collaborationRoomMember.roomId, f.roomId),
      eq(schema.collaborationRoomMember.userId, f.guest),
    ),
  });
const inviteRow = (f: Fixture) =>
  testDb.query.collaborationRoomInvite.findFirst({
    where: and(
      eq(schema.collaborationRoomInvite.roomId, f.roomId),
      eq(schema.collaborationRoomInvite.emailKey, guestEmail(f)),
    ),
  });
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
    expect((await listGuest(f)).rooms).toEqual([]);
    await applyRoomProjection(
      db,
      f.projection({ version: 5, role: "viewer", listedAt: 500 }),
    );
    const result = await listGuest(f);
    expect(result.rooms).toMatchObject([
      { roomId: f.roomId, role: "viewer", listedAt: 100 },
    ]);
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ authorityEpoch: 5, storageState: "ready" });
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
    const first = await listGuest(f, { limit: 2 });
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
    const next = await listGuest(f, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
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
    expect((await listGuest(f)).rooms).toEqual([]);
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
  it("stores the access a member row lists under and clears role and access on tombstones", async () => {
    const f = await adapterFixture(db);
    await applyRoomProjection(db, f.projection({ access: "link" }));
    expect(await memberRow(f)).toMatchObject({
      role: "editor",
      access: "link",
      revokedAt: null,
    });
    await applyRoomProjection(
      db,
      f.projection({ version: 3, tombstone: true }),
    );
    const tombstone = await memberRow(f);
    expect(tombstone).toMatchObject({ role: null, access: null });
    expect(tombstone?.revokedAt).toBeInstanceOf(Date);
    await applyRoomProjection(
      db,
      f.projection({ version: 4, role: "viewer", access: "invited" }),
    );
    expect(await memberRow(f)).toMatchObject({
      role: "viewer",
      access: "invited",
      revokedAt: null,
    });
  });
  it("applies invite projections monotonically, tombstones them and syncs the room's display fields", async () => {
    const f = await adapterFixture(db);
    expect(
      await applyInviteProjection(db, f.invite({ label: "Invited" })),
    ).toEqual({ applied: true });
    expect(await inviteRow(f)).toMatchObject({
      role: "editor",
      revokedAt: null,
      projectionVersion: 2,
    });
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ label: "Invited", projectionVersion: 2 });
    expect(await applyInviteProjection(db, f.invite())).toEqual({
      applied: false,
    });
    await applyInviteProjection(db, f.invite({ version: 4, tombstone: true }));
    expect(
      await applyInviteProjection(db, f.invite({ version: 3, role: "viewer" })),
    ).toEqual({ applied: false });
    const revoked = await inviteRow(f);
    expect(revoked).toMatchObject({ role: null, projectionVersion: 4 });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    await applyInviteProjection(db, f.invite({ version: 5, role: "viewer" }));
    expect(await inviteRow(f)).toMatchObject({
      role: "viewer",
      revokedAt: null,
    });
    expect(
      await applyInviteProjection(
        db,
        f.invite({ roomId: roomIdSchema.parse("missing-room") }),
      ),
    ).toEqual({ applied: false });
    expect(
      await testDb.query.collaborationRoomInvite.findFirst({
        where: eq(schema.collaborationRoomInvite.roomId, "missing-room"),
      }),
    ).toBeUndefined();
  });
  it("deletes an ended room's per-person rows and name when its projections end it, and drops late events", async () => {
    const f = await adapterFixture(db);
    await applyRoomProjection(db, f.projection({ label: "Secret plans" }));
    await applyRoomProjection(
      db,
      f.projection({ version: 3, tombstone: true }),
    );
    await applyRoomProjection(
      db,
      f.projection({ subject: f.owner, role: "owner", access: "owned" }),
    );
    await applyInviteProjection(db, f.invite());
    expect(await endedRoomRecords(db, f.roomId)).toMatchObject({
      members: 2,
      invites: 1,
      tombstones: 1,
    });
    const ended = { version: 4, status: "ended", tombstone: true } as const;
    expect(await applyRoomProjection(db, f.projection(ended))).toEqual({
      applied: true,
    });
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ status: "ended", label: "" });
    // The room has ended: the remaining rows are deleted, not tombstoned.
    expect(
      await applyRoomProjection(
        db,
        f.projection({ ...ended, subject: f.owner }),
      ),
    ).toEqual({ applied: false });
    expect(await applyInviteProjection(db, f.invite(ended))).toEqual({
      applied: false,
    });
    expect(await endedRoomRecords(db, f.roomId)).toEqual(NO_ROOM_RECORDS);
    // Late live events never bring rows back.
    expect(await applyRoomProjection(db, f.projection({ version: 5 }))).toEqual(
      { applied: false },
    );
    expect(await applyInviteProjection(db, f.invite({ version: 5 }))).toEqual({
      applied: false,
    });
    expect(await endedRoomRecords(db, f.roomId)).toEqual(NO_ROOM_RECORDS);
  });
  it("keeps nothing when storage cleanup runs before the room's projections arrive", async () => {
    const f = await adapterFixture(db);
    await applyRoomProjection(db, f.projection({ label: "Secret plans" }));
    await applyInviteProjection(db, f.invite());
    await applyStorageFence(db, f.fence(2, { state: "ended" }));
    await cleanupAdapterRoom(db, { ...f.fence(2), action: "cleanup" });
    expect(await endedRoomRecords(db, f.roomId)).toEqual(NO_ROOM_RECORDS);
    for (const event of [
      f.projection({ version: 3, listedAt: 300 }),
      f.projection({ version: 4, status: "ended", tombstone: true }),
    ])
      expect(await applyRoomProjection(db, event)).toEqual({ applied: false });
    for (const event of [
      f.invite({ version: 3 }),
      f.invite({ version: 4, status: "ended", tombstone: true }),
    ])
      expect(await applyInviteProjection(db, event)).toEqual({
        applied: false,
      });
    expect(await endedRoomRecords(db, f.roomId)).toEqual(NO_ROOM_RECORDS);
    expect(
      await testDb.query.collaborationRoom.findFirst({
        where: eq(schema.collaborationRoom.roomId, f.roomId),
      }),
    ).toMatchObject({ storageState: "ended", label: "" });
  });
  it("drops events for a missing room without recording anything", async () => {
    const f = await adapterFixture(db);
    await testDb
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    expect(await applyRoomProjection(db, f.projection())).toEqual({
      applied: false,
    });
    expect(await endedRoomRecords(db, f.roomId)).toEqual(NO_ROOM_RECORDS);
  });
  it("lists owned, invited and unopened invitations under mine, and link rooms separately", async () => {
    const f = await adapterFixture(db);
    const email = guestEmail(f);
    const owned = await addRoom(f, "list-owned");
    const invited = await addRoom(f, "list-invited");
    const opened = await addRoom(f, "list-opened");
    const unopened = await addRoom(f, "list-unopened");
    const linked = await addRoom(f, "list-link");
    const revoked = await addRoom(f, "list-revoked");
    await applyRoomProjection(
      db,
      f.projection({
        roomId: owned,
        role: "owner",
        access: "owned",
        listedAt: 600,
      }),
    );
    await applyRoomProjection(
      db,
      f.projection({ roomId: invited, access: "invited", listedAt: 500 }),
    );
    // Opened invitation: both rows exist; it is listed once, from the member row.
    await applyInviteProjection(db, f.invite({ roomId: opened, listedAt: 50 }));
    await applyRoomProjection(
      db,
      f.projection({
        roomId: opened,
        role: "viewer",
        access: "invited",
        listedAt: 400,
      }),
    );
    await applyInviteProjection(
      db,
      f.invite({ roomId: unopened, role: "viewer", listedAt: 300 }),
    );
    await applyRoomProjection(
      db,
      f.projection({ roomId: linked, access: "link", listedAt: 200 }),
    );
    await applyInviteProjection(
      db,
      f.invite({ roomId: revoked, listedAt: 700 }),
    );
    await applyInviteProjection(
      db,
      f.invite({ roomId: revoked, version: 3, tombstone: true }),
    );
    const mine = await listGuest(f, {}, email);
    expect(mine).toEqual({
      rooms: [
        expect.objectContaining({
          roomId: owned,
          role: "owner",
          access: "owned",
          listedAt: 600,
        }),
        expect.objectContaining({
          roomId: invited,
          role: "editor",
          access: "invited",
          listedAt: 500,
        }),
        expect.objectContaining({
          roomId: opened,
          role: "viewer",
          access: "invited",
          listedAt: 400,
        }),
        expect.objectContaining({
          roomId: unopened,
          role: "viewer",
          access: "invited",
          listedAt: 300,
        }),
      ],
      nextCursor: null,
    });
    expect(
      (await listGuest(f, { section: "link" }, email)).rooms,
    ).toMatchObject([{ roomId: linked, role: "editor", access: "link" }]);
    // Without a verified address, unopened invitations stay hidden.
    expect((await listGuest(f)).rooms.map((row) => row.roomId)).toEqual([
      owned,
      invited,
      opened,
    ]);
    // A leave newer than the still-live invitation hides the room.
    await applyRoomProjection(
      db,
      f.projection({ roomId: opened, version: 3, tombstone: true }),
    );
    expect(
      (await listGuest(f, {}, email)).rooms.map((row) => row.roomId),
    ).not.toContain(opened);
  });
  it("lets the newer of the account's row and its invitation decide the listing", async () => {
    const f = await adapterFixture(db);
    const email = guestEmail(f);
    const listed = async (section: "mine" | "link") =>
      (await listGuest(f, { section }, email)).rooms;
    // A re-invitation newer than a leave lists the room again.
    const rejoined = await addRoom(f, "newer-reinvite");
    await applyRoomProjection(db, f.projection({ roomId: rejoined }));
    await applyRoomProjection(
      db,
      f.projection({ roomId: rejoined, version: 3, tombstone: true }),
    );
    await applyInviteProjection(
      db,
      f.invite({ roomId: rejoined, version: 4, role: "viewer", listedAt: 400 }),
    );
    // A newer invitation moves a link-opened room from link to mine.
    const promoted = await addRoom(f, "newer-invite-over-link");
    await applyRoomProjection(
      db,
      f.projection({ roomId: promoted, access: "link", listedAt: 300 }),
    );
    await applyInviteProjection(
      db,
      f.invite({ roomId: promoted, version: 3, listedAt: 300 }),
    );
    // A newer invitation removal hides an older invited member row.
    const uninvited = await addRoom(f, "newer-uninvite");
    await applyRoomProjection(db, f.projection({ roomId: uninvited }));
    await applyInviteProjection(db, f.invite({ roomId: uninvited }));
    await applyInviteProjection(
      db,
      f.invite({ roomId: uninvited, version: 3, tombstone: true }),
    );
    expect(await listed("mine")).toEqual([
      expect.objectContaining({
        roomId: rejoined,
        role: "viewer",
        access: "invited",
        listedAt: 400,
      }),
      expect.objectContaining({
        roomId: promoted,
        role: "editor",
        access: "invited",
      }),
    ]);
    expect(await listed("link")).toEqual([]);
  });
  it("pages mine across member and invitation rows with one keyset", async () => {
    const f = await adapterFixture(db);
    const email = guestEmail(f);
    const ids: string[] = [];
    for (const [index, listedAt] of [400, 300, 200, 100].entries()) {
      const roomId = await addRoom(f, `keyset-${index}`);
      ids.push(roomId);
      if (index % 2 === 0)
        await applyRoomProjection(db, f.projection({ roomId, listedAt }));
      else await applyInviteProjection(db, f.invite({ roomId, listedAt }));
    }
    const first = await listGuest(f, { limit: 3 }, email);
    expect(first.rooms.map((row) => row.roomId)).toEqual(ids.slice(0, 3));
    expect(first.nextCursor).toEqual({ listedAt: 200, roomId: ids[2] });
    const next = await listGuest(
      f,
      { limit: 3, cursor: first.nextCursor ?? undefined },
      email,
    );
    expect(next).toEqual({
      rooms: [expect.objectContaining({ roomId: ids[3] })],
      nextCursor: null,
    });
  });
  it("lists nothing for a frozen account, invitations included", async () => {
    const f = await adapterFixture(db);
    await applyRoomProjection(db, f.projection());
    const other = await addRoom(f, "frozen-invite");
    await applyInviteProjection(db, f.invite({ roomId: other }));
    expect((await listGuest(f, {}, guestEmail(f))).rooms).toHaveLength(2);
    await testDb.insert(schema.collaborationLifecycleSubject).values({
      scope: `account:${f.guest}`,
      kind: "account",
      subject: f.guest,
      frozen: true,
    });
    expect(await listGuest(f, {}, guestEmail(f))).toEqual({
      rooms: [],
      nextCursor: null,
    });
  });
});
