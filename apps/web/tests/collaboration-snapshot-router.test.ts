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

/** The relay is a separate process; snapshots never involve it. */
vi.mock("@/server/collab/relay-control", () => ({
  pushRelayRoomControl: () =>
    Promise.resolve({ enforced: true, closedSessions: 0 }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";

import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
  SNAPSHOT_CRYPTO_VERSION,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";

import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";

/**
 * Durable snapshot storage as the API exposes it.
 *
 * Two properties are load-bearing and both are asserted against real Postgres
 * DDL rather than a mock: the authorization rules (who may read a baseline, who
 * may replace it) and the optimistic revision guard that stops a writer holding
 * a stale scene from overwriting a newer snapshot. The ciphertext itself is
 * opaque here on purpose — that is the whole point of the boundary, and its
 * sealing is covered in `@drawstuff/collaboration`.
 */

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const STRANGER = "user-stranger";

function callerFor(userId: string | null) {
  const ctx = {
    db: testDb,
    headers: new Headers(),
    auth: userId
      ? { session: { id: `session-${userId}` }, user: { id: userId } }
      : null,
  } as unknown as TRPCContext;
  return createCaller(ctx);
}

async function createScene(userId: string): Promise<string> {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId, sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

/** Opaque bytes: the server never opens these, so any content will do. */
const ciphertext = (byteLength: number, fill = 7): Uint8Array => {
  const bytes = new Uint8Array(byteLength).fill(fill);
  bytes[0] = SNAPSHOT_CRYPTO_VERSION;
  return bytes;
};

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

/** 64 hex chars; the server stores it, it does not recompute it. */
const checksum = (seed: string): string =>
  seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");

const put = (
  userId: string,
  input: {
    roomId: string;
    expectedRevision: number;
    /** Generation the caller sealed under; defaults to a fresh room's. */
    authGeneration?: number;
    bytes?: Uint8Array;
    checksum?: string;
  },
) =>
  callerFor(userId).collaborationSnapshot.put({
    roomId: input.roomId,
    authGeneration: input.authGeneration ?? 1,
    expectedRevision: input.expectedRevision,
    cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
    ciphertextBase64: base64(input.bytes ?? ciphertext(64)),
    checksum: input.checksum ?? checksum("ab"),
  });

async function openRoom(
  options: { linkRole?: "none" | "viewer" | "editor" } = {},
) {
  const sceneId = await createScene(OWNER);
  const room = await callerFor(OWNER).collaborationRoom.create({
    sceneId,
    linkRole: options.linkRole ?? "none",
  });
  return room;
}

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
  await testDb.delete(schema.collaborationSnapshot);
  await testDb.delete(schema.collaborationRoomMember);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: EDITOR, name: "Editor", email: "editor@example.com" },
    { id: VIEWER, name: "Viewer", email: "viewer@example.com" },
    { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
  ]);
});

describe("collaboration snapshot reads", () => {
  it("reports no baseline for a room that has never had one", async () => {
    const room = await openRoom();
    const result = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(result).toEqual({ authGeneration: 1, snapshot: null });
  });

  it("returns the stored bytes unchanged, with the metadata a client needs", async () => {
    const room = await openRoom();
    const bytes = ciphertext(128, 9);
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
      bytes,
      checksum: checksum("cd"),
    });

    const result = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(result.authGeneration).toBe(1);
    expect(result.snapshot).toMatchObject({
      revision: 1,
      cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
      byteLength: 128,
      checksum: checksum("cd"),
    });
    expect(result.snapshot?.ciphertextBase64).toBe(base64(bytes));
  });

  it("lets a viewer read the baseline but never write one", async () => {
    const room = await openRoom({ linkRole: "viewer" });
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    // A viewer needs the baseline to see the room at all.
    const read = await callerFor(VIEWER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(read.snapshot?.revision).toBe(1);
    // Writing one would be editing the room through the back door, which the
    // relay refuses on the realtime path.
    await expect(
      put(VIEWER, { roomId: room.roomId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses unauthorized and anonymous callers on both operations", async () => {
    const room = await openRoom();
    await expect(
      callerFor(STRANGER).collaborationSnapshot.get({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      put(STRANGER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(null).collaborationSnapshot.get({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses an ended room", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.end({ roomId: room.roomId });
    await expect(
      callerFor(OWNER).collaborationSnapshot.get({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("reports no baseline after the generation is rotated", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });
    // The previous generation's ciphertext is cryptographically unreadable, so
    // the honest answer for the new generation is "no baseline yet".
    const result = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(result.authGeneration).toBe(2);
    expect(result.snapshot).toBeNull();
  });
});

describe("collaboration snapshot conditional writes", () => {
  it("creates at revision 1 and advances by one per accepted write", async () => {
    const room = await openRoom();
    expect(
      await put(OWNER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
      }),
    ).toEqual({ status: "written", revision: 1 });
    expect(
      await put(OWNER, { roomId: room.roomId, expectedRevision: 1 }),
    ).toEqual({ status: "written", revision: 2 });
  });

  it("refuses a stale writer and tells it the current revision", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });
    await put(OWNER, { roomId: room.roomId, expectedRevision: 1 });

    const stale = ciphertext(64, 1);
    expect(
      await put(OWNER, {
        roomId: room.roomId,
        expectedRevision: 1,
        bytes: stale,
      }),
    ).toEqual({ status: "conflict", currentRevision: 2 });

    // The newer snapshot survived: a stale writer cannot overwrite it.
    const stored = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(stored.snapshot?.revision).toBe(2);
    expect(stored.snapshot?.ciphertextBase64).not.toBe(base64(stale));
  });

  it("turns a lost create race into a conflict, not a constraint error", async () => {
    const room = await openRoom();
    // Two clients both start in what they believe is an empty room.
    const [first, second] = await Promise.all([
      put(OWNER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
        bytes: ciphertext(64, 1),
      }),
      put(OWNER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
        bytes: ciphertext(64, 2),
      }),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["conflict", "written"]);
  });

  it("reports a conflict with no revision when the row is gone", async () => {
    const room = await openRoom();
    // No snapshot exists, and this writer claims one does.
    expect(
      await put(OWNER, { roomId: room.roomId, expectedRevision: 5 }),
    ).toEqual({ status: "conflict", currentRevision: undefined });
  });

  it("keeps one row per room generation and retires older generations", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });
    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });
    await put(OWNER, {
      roomId: room.roomId,
      authGeneration: 2,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    // Retention is bounded by construction: the rotated generation's ciphertext
    // can never be opened again, so keeping it would be storage nobody can use.
    const rows = await testDb
      .select()
      .from(schema.collaborationSnapshot)
      .where(eq(schema.collaborationSnapshot.roomId, room.roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authGeneration).toBe(2);
  });

  it("records who wrote the baseline and keeps byteLength honest", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: EDITOR,
      role: "editor",
    });
    await put(EDITOR, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
      bytes: ciphertext(200),
    });

    const [row] = await testDb
      .select()
      .from(schema.collaborationSnapshot)
      .where(
        and(
          eq(schema.collaborationSnapshot.roomId, room.roomId),
          eq(schema.collaborationSnapshot.authGeneration, 1),
        ),
      );
    expect(row?.updatedBy).toBe(EDITOR);
    expect(row?.byteLength).toBe(200);
    expect(row?.ciphertext.byteLength).toBe(200);
  });

  it("bounds ciphertext size on both ends", async () => {
    const room = await openRoom();
    await expect(
      put(OWNER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
        bytes: ciphertext(MIN_SNAPSHOT_SEALED_BYTES - 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // The base64 length cap rejects the oversize payload before it is decoded,
    // so an authorized member cannot grow the database without limit.
    await expect(
      put(OWNER, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
        bytes: ciphertext(MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1_024),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a malformed checksum, a foreign crypto version and bad base64", async () => {
    const room = await openRoom();
    const valid = {
      roomId: room.roomId,
      authGeneration: 1,
      expectedRevision: SNAPSHOT_NO_REVISION,
      cryptoVersion: SNAPSHOT_CRYPTO_VERSION as typeof SNAPSHOT_CRYPTO_VERSION,
      ciphertextBase64: base64(ciphertext(64)),
      checksum: checksum("ab"),
    };
    const caller = callerFor(OWNER);

    await expect(
      caller.collaborationSnapshot.put({
        ...valid,
        checksum: "not-a-checksum",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.collaborationSnapshot.put({
        ...valid,
        cryptoVersion: (SNAPSHOT_CRYPTO_VERSION +
          1) as typeof SNAPSHOT_CRYPTO_VERSION,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.collaborationSnapshot.put({
        ...valid,
        ciphertextBase64: "not base64!!",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.collaborationSnapshot.put({ ...valid, expectedRevision: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a write sealed for a superseded generation", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
      bytes: ciphertext(64, 1),
    });
    await callerFor(OWNER).collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });

    // A client that derived its key under generation 1 must not have its
    // ciphertext filed under generation 2: the row would be unopenable, and
    // writing it would retire the generation-1 row that is still readable.
    await expect(
      put(OWNER, {
        roomId: room.roomId,
        authGeneration: 1,
        expectedRevision: SNAPSHOT_NO_REVISION,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const rows = await testDb
      .select()
      .from(schema.collaborationSnapshot)
      .where(eq(schema.collaborationSnapshot.roomId, room.roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authGeneration).toBe(1);
    expect(rows[0]?.ciphertext).toEqual(ciphertext(64, 1));
  });

  it("refuses a write from an editor whose membership was revoked", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: EDITOR,
      role: "editor",
    });
    await put(EDITOR, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
      bytes: ciphertext(64, 1),
    });

    await callerFor(OWNER).collaborationRoom.removeMember({
      roomId: room.roomId,
      userId: EDITOR,
    });

    // Authorization and the write share one transaction under the room lock, so a
    // revocation cannot commit "between" them and leave a removed editor still
    // able to replace the room's durable baseline.
    await expect(
      put(EDITOR, { roomId: room.roomId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const stored = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(stored.snapshot?.revision).toBe(1);
  });

  it("refuses a write from an editor downgraded to viewer", async () => {
    const room = await openRoom();
    await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: EDITOR,
      role: "editor",
    });
    await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: EDITOR,
      role: "viewer",
    });
    await expect(
      put(EDITOR, {
        roomId: room.roomId,
        expectedRevision: SNAPSHOT_NO_REVISION,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a write claiming a generation the room has not reached", async () => {
    const room = await openRoom();
    await expect(
      put(OWNER, {
        roomId: room.roomId,
        authGeneration: 99,
        expectedRevision: SNAPSHOT_NO_REVISION,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await testDb.select().from(schema.collaborationSnapshot)).toEqual(
      [],
    );
  });

  it("is dropped with its room, leaving no orphan ciphertext", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    await testDb
      .delete(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.roomId, room.roomId));
    const rows = await testDb.select().from(schema.collaborationSnapshot);
    expect(rows).toEqual([]);
  });
});

describe("collaboration snapshot reset (Plan 34)", () => {
  it("lets the owner delete the current baseline so the room re-seeds", async () => {
    const room = await openRoom();
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    const result = await callerFor(OWNER).collaborationSnapshot.reset({
      roomId: room.roomId,
    });
    expect(result).toEqual({ reset: true });

    const after = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(after.snapshot).toBeNull();

    // The next write is a fresh seed at revision 1, not a continuation.
    const reseeded = await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });
    expect(reseeded).toEqual({ status: "written", revision: 1 });
  });

  it("reports when there was nothing to delete", async () => {
    const room = await openRoom();
    await expect(
      callerFor(OWNER).collaborationSnapshot.reset({ roomId: room.roomId }),
    ).resolves.toEqual({ reset: false });
  });

  it("refuses everyone but the owner — an editor's write access is not enough", async () => {
    const room = await openRoom({ linkRole: "editor" });
    await put(OWNER, {
      roomId: room.roomId,
      expectedRevision: SNAPSHOT_NO_REVISION,
    });

    // An editor may replace the baseline (visibly) but not discard it.
    await expect(
      callerFor(EDITOR).collaborationSnapshot.reset({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(null).collaborationSnapshot.reset({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const kept = await callerFor(OWNER).collaborationSnapshot.get({
      roomId: room.roomId,
    });
    expect(kept.snapshot).not.toBeNull();
  });
});
