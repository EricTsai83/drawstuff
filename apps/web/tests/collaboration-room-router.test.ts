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
 * The relay is a separate process; its side of enforcement is covered by the
 * relay integration tests. Here the push itself is the assertion: a membership
 * change must reach the relay so sockets that already joined are closed.
 */
const relayControlCalls: unknown[] = [];
vi.mock("@/server/collab/relay-control", () => ({
  pushRelayRoomControl: (params: unknown) => {
    relayControlCalls.push(params);
    return Promise.resolve({ enforced: true, closedSessions: 1 });
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";

import {
  KEYCHECK_CIPHERTEXT_BYTES,
  sealRoomKeyCheck,
  verifyRoomKeyCheck,
} from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import { verifyJoinToken } from "@drawstuff/collaboration/room-token";

import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const TOKEN_SECRET = "web-test-room-token-secret-0123456789";
const RELAY_URL = "ws://127.0.0.1:3105";

const client = new PGlite();
const testDb = drizzle(client, { schema });

const OWNER = "user-owner";
const GUEST = "user-guest";
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

async function createScene(userId: string, name = "scene"): Promise<string> {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name, userId, sceneData: "stub" })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("failed to insert scene");
  return row.id;
}

const verify = (
  token: string,
  options: {
    roomId: string;
    nowSeconds?: number;
  },
) =>
  verifyJoinToken({
    token,
    secret: TOKEN_SECRET,
    nowSeconds: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    expectedRoomId: roomIdSchema.parse(options.roomId),
  });

const claimsOf = (token: string, options: { roomId: string }) => {
  const result = verify(token, options);
  if (!result.ok) throw new Error(`token rejected: ${result.reason}`);
  return result.claims;
};

/**
 * Stores a key-check value for the room, which `join` requires (Plan 34): no
 * token is issued for a room whose key cannot be verified. Tests that expect a
 * join to succeed arm the room first, the way the owner's client does right
 * after `create` and `rotateGeneration`.
 */
const armKeyCheck = async (room: {
  roomId: string;
  authGeneration: number;
}) => {
  await callerFor(OWNER).collaborationRoom.setKeyCheck({
    roomId: room.roomId,
    authGeneration: room.authGeneration,
    keyCheckBase64: await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: room.authGeneration,
    }),
  });
};

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
  relayControlCalls.length = 0;
  await testDb.delete(schema.collaborationRoomMember);
  await testDb.delete(schema.collaborationRoom);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: GUEST, name: "Guest", email: "guest@example.com" },
    { id: STRANGER, name: "Stranger", email: "stranger@example.com" },
  ]);
});

describe("collaboration room creation", () => {
  it("opens a room for a scene the caller owns", async () => {
    const sceneId = await createScene(OWNER);
    const room = await callerFor(OWNER).collaborationRoom.create({ sceneId });

    expect(room.sceneId).toBe(sceneId);
    expect(room.authGeneration).toBe(1);
    expect(room.linkRole).toBe("none");
    expect(room.status).toBe("active");
    expect(room.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The owner is recorded as a member so the panel can list participants.
    const members = await callerFor(OWNER).collaborationRoom.get({
      roomId: room.roomId,
    });
    expect(members.members).toEqual([
      { userId: OWNER, name: "Owner", role: "owner", revoked: false },
    ]);
  });

  it("keeps one active room per scene and refreshes its window", async () => {
    const sceneId = await createScene(OWNER);
    const caller = callerFor(OWNER);
    const first = await caller.collaborationRoom.create({ sceneId });
    const second = await caller.collaborationRoom.create({
      sceneId,
      linkRole: "viewer",
    });

    expect(second.roomId).toBe(first.roomId);
    expect(second.linkRole).toBe("viewer");
    const rooms = await testDb
      .select()
      .from(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.sceneId, sceneId));
    expect(rooms).toHaveLength(1);
  });

  it("refuses a scene the caller does not own, and refuses anonymous callers", async () => {
    const sceneId = await createScene(OWNER);
    await expect(
      callerFor(GUEST).collaborationRoom.create({ sceneId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Anonymous collaboration is off: there is no unauthenticated room path.
    await expect(
      callerFor(null).collaborationRoom.create({ sceneId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      callerFor(null).collaborationRoom.join({
        roomId: "any-room",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("collaboration room join tokens", () => {
  it("issues an owner token bound to the room, generation and user", async () => {
    const sceneId = await createScene(OWNER);
    const caller = callerFor(OWNER);
    const room = await caller.collaborationRoom.create({ sceneId });
    await armKeyCheck(room);
    const joined = await caller.collaborationRoom.join({
      roomId: room.roomId,
    });

    expect(joined.role).toBe("owner");
    expect(joined.relayUrl).toBe(RELAY_URL);
    expect(joined.tokenExpiresAt).toBeGreaterThan(Date.now());
    const claims = claimsOf(joined.token, {
      roomId: room.roomId,
    });
    expect(claims).toMatchObject({
      rid: room.roomId,
      gen: 1,
      sub: OWNER,
      role: "owner",
    });
    // A token is authorization only: no key material, ever.
    expect(Object.keys(claims)).not.toContain("key");
    expect(joined.token).not.toContain(TOKEN_SECRET);
  });

  it("refuses a token for a user with no membership and no link role", async () => {
    const sceneId = await createScene(OWNER);
    const room = await callerFor(OWNER).collaborationRoom.create({ sceneId });
    await expect(
      callerFor(GUEST).collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("grants the link role and records the joiner as a revocable member", async () => {
    const sceneId = await createScene(OWNER);
    const room = await callerFor(OWNER).collaborationRoom.create({
      sceneId,
      linkRole: "viewer",
    });
    await armKeyCheck(room);
    const joined = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });

    expect(joined.role).toBe("viewer");
    expect(
      claimsOf(joined.token, { roomId: room.roomId })
        .role,
    ).toBe("viewer");
    const room2 = await callerFor(OWNER).collaborationRoom.get({
      roomId: room.roomId,
    });
    expect(
      room2.members.find((member) => member.userId === GUEST),
    ).toMatchObject({ role: "viewer", revoked: false });
  });

  it("refuses a room that is not found, has ended, or has expired", async () => {
    const sceneId = await createScene(OWNER);
    const caller = callerFor(OWNER);
    await expect(
      caller.collaborationRoom.join({
        roomId: "missing-room",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const room = await caller.collaborationRoom.create({ sceneId });
    await testDb
      .update(schema.collaborationRoom)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.collaborationRoom.roomId, room.roomId));
    await expect(
      caller.collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("collaboration room membership changes", () => {
  const setupRoom = async (
    linkRole: "none" | "viewer" | "editor" = "viewer",
  ) => {
    const sceneId = await createScene(OWNER);
    const room = await callerFor(OWNER).collaborationRoom.create({
      sceneId,
      linkRole,
    });
    await armKeyCheck(room);
    await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    relayControlCalls.length = 0;
    return room;
  };

  it("upgrades a member's role and forces a reconnect to pick it up", async () => {
    const room = await setupRoom();
    const result = await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: GUEST,
      role: "editor",
    });

    expect(result).toEqual({ role: "editor", relayEnforced: true });
    // The role a live socket carries came from its token, so the member's
    // sessions must be closed for the new role to take effect.
    expect(relayControlCalls).toEqual([
      expect.objectContaining({
        action: "revoke-member",
        roomId: room.roomId,
        authGeneration: 1,
        userId: GUEST,
      }),
    ]);
    const rejoined = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    expect(rejoined.role).toBe("editor");
  });

  it("blocks a removed member and pushes the revocation to the relay", async () => {
    const room = await setupRoom();
    const beforeRemoval = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    relayControlCalls.length = 0;

    const removed = await callerFor(OWNER).collaborationRoom.removeMember({
      roomId: room.roomId,
      userId: GUEST,
    });
    expect(removed).toEqual({ removed: true, relayEnforced: true });
    expect(relayControlCalls).toEqual([
      expect.objectContaining({ action: "revoke-member", userId: GUEST }),
    ]);

    // New connections are refused immediately, even though the room's link
    // role would otherwise admit anyone with the link.
    await expect(
      callerFor(GUEST).collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Time-of-check/time-of-use is bounded, not eliminated: the token minted
    // before removal stays cryptographically valid until it expires, which is
    // exactly why the revocation is also pushed to the relay above.
    expect(
      verify(beforeRemoval.token, {
        roomId: room.roomId,
      }).ok,
    ).toBe(true);
    const members = await callerFor(OWNER).collaborationRoom.get({
      roomId: room.roomId,
    });
    expect(
      members.members.find((member) => member.userId === GUEST),
    ).toMatchObject({ revoked: true });
  });

  it("reinstates a removed member only through an explicit role grant", async () => {
    const room = await setupRoom();
    await callerFor(OWNER).collaborationRoom.removeMember({
      roomId: room.roomId,
      userId: GUEST,
    });
    await callerFor(OWNER).collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: GUEST,
      role: "viewer",
    });
    const rejoined = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    expect(rejoined.role).toBe("viewer");
  });

  it("lets a member leave and refuses to let the owner leave", async () => {
    const room = await setupRoom();
    const left = await callerFor(GUEST).collaborationRoom.leave({
      roomId: room.roomId,
    });
    expect(left).toEqual({ left: true, relayEnforced: true });
    expect(relayControlCalls).toEqual([
      expect.objectContaining({ action: "revoke-member", userId: GUEST }),
    ]);
    const membership = await testDb
      .select()
      .from(schema.collaborationRoomMember)
      .where(
        and(
          eq(schema.collaborationRoomMember.roomId, room.roomId),
          eq(schema.collaborationRoomMember.userId, GUEST),
        ),
      );
    expect(membership[0]?.revokedAt).not.toBeNull();

    await expect(
      callerFor(OWNER).collaborationRoom.leave({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("restricts room administration to the owner", async () => {
    const room = await setupRoom();
    const guest = callerFor(GUEST);
    await expect(
      guest.collaborationRoom.removeMember({
        roomId: room.roomId,
        userId: OWNER,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      guest.collaborationRoom.setLinkRole({
        roomId: room.roomId,
        linkRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      guest.collaborationRoom.end({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      guest.collaborationRoom.rotateGeneration({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(relayControlCalls).toEqual([]);
  });

  it("hides an invite-only room from callers who only have the link", async () => {
    const sceneId = await createScene(OWNER, "invite-only");
    const room = await callerFor(OWNER).collaborationRoom.create({
      sceneId,
      linkRole: "none",
    });
    const stranger = callerFor(STRANGER);
    // The link is a locator, not a credential: no membership, no room state.
    await expect(
      stranger.collaborationRoom.get({ roomId: room.roomId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      stranger.collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await stranger.collaborationRoom.getActiveForScene({ sceneId }),
    ).toBeNull();
  });

  it("refuses to change or remove the owner's own membership", async () => {
    const room = await setupRoom();
    const owner = callerFor(OWNER);
    await expect(
      owner.collaborationRoom.setMemberRole({
        roomId: room.roomId,
        userId: OWNER,
        role: "viewer",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      owner.collaborationRoom.removeMember({
        roomId: room.roomId,
        userId: OWNER,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("collaboration room lifecycle", () => {
  it("ends a room, closing live sessions and refusing new tokens", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({
      sceneId,
      linkRole: "editor",
    });
    await armKeyCheck(room);
    await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    relayControlCalls.length = 0;

    const ended = await owner.collaborationRoom.end({ roomId: room.roomId });
    expect(ended).toMatchObject({ ended: true, relayEnforced: true });
    expect(relayControlCalls).toEqual([
      expect.objectContaining({
        action: "end-room",
        roomId: room.roomId,
        authGeneration: 1,
      }),
    ]);

    await expect(
      callerFor(GUEST).collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await owner.collaborationRoom.getActiveForScene({ sceneId }),
    ).toBeNull();
    // A new room can be opened for the same scene once the old one is closed.
    const reopened = await owner.collaborationRoom.create({ sceneId });
    expect(reopened.roomId).not.toBe(room.roomId);
  });

  it("rotates the generation so outstanding tokens can no longer be used", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({
      sceneId,
      linkRole: "editor",
    });
    await armKeyCheck(room);
    const beforeRotation = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    relayControlCalls.length = 0;

    const rotated = await owner.collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });
    expect(rotated).toEqual({ authGeneration: 2, relayEnforced: true });
    // The previous generation's relay channel is emptied.
    expect(relayControlCalls).toEqual([
      expect.objectContaining({ action: "end-room", authGeneration: 1 }),
    ]);

    // The old token still verifies on its own, but it addresses generation 1 —
    // a channel nobody can join any more — while new tokens address 2. This is
    // the cryptographic-revocation hook, distinct from removing a member.
    const oldClaims = claimsOf(beforeRotation.token, {
      roomId: room.roomId,
    });
    expect(oldClaims.gen).toBe(1);
    // Rotation cleared the check value; the owner recomputes it for the new
    // generation before the new link goes out, and joins resume only then.
    await armKeyCheck({ roomId: room.roomId, authGeneration: 2 });
    const afterRotation = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    expect(
      claimsOf(afterRotation.token, {
        roomId: room.roomId,
      }).gen,
    ).toBe(2);
    expect(afterRotation.authGeneration).toBe(2);
  });

  it("keeps the room's own expiry in the token so the relay can bound the session", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({
      sceneId,
      ttlMinutes: 30,
    });
    await armKeyCheck(room);
    const joined = await owner.collaborationRoom.join({
      roomId: room.roomId,
    });
    const claims = claimsOf(joined.token, {
      roomId: room.roomId,
    });
    // Without this the relay could only refuse the next join, leaving an
    // already-connected socket alive past the room's lifetime.
    expect(claims.rexp).toBe(Math.ceil(room.expiresAt.getTime() / 1000));
    expect(claims.rexp * 1000).toBeGreaterThan(claims.exp * 1000);
  });

  it("ends the generation that is current after a rotation", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });
    await owner.collaborationRoom.rotateGeneration({ roomId: room.roomId });
    relayControlCalls.length = 0;

    await owner.collaborationRoom.end({ roomId: room.roomId });
    // Ending must close the live generation, not the one a rotation left
    // behind: sessions of generation 2 would otherwise survive the end.
    expect(relayControlCalls).toEqual([
      expect.objectContaining({ action: "end-room", authGeneration: 2 }),
    ]);
  });

  it("orders a revocation above a join that won the race for the lock", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({
      sceneId,
      linkRole: "editor",
    });
    await armKeyCheck(room);
    const joined = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    relayControlCalls.length = 0;

    await owner.collaborationRoom.removeMember({
      roomId: room.roomId,
      userId: GUEST,
    });
    const tokenRevision = claimsOf(joined.token, {
      roomId: room.roomId,
    }).arev;
    const cutoff = relayControlCalls[0] as { authRevision: number };
    // Ordering by revision rather than by wall clock is what makes the cutoff
    // exact: it must outrank every token issued before the revocation, even
    // one issued while the revocation was waiting for the room lock.
    expect(cutoff.authRevision).toBeGreaterThan(tokenRevision);

    // Re-granting bumps the revision again, so the next token outranks the
    // cutoff and the member is usable immediately.
    await owner.collaborationRoom.setMemberRole({
      roomId: room.roomId,
      userId: GUEST,
      role: "viewer",
    });
    const regrantCutoff = relayControlCalls[1] as { authRevision: number };
    const rejoined = await callerFor(GUEST).collaborationRoom.join({
      roomId: room.roomId,
    });
    expect(
      claimsOf(rejoined.token, {
        roomId: room.roomId,
      }).arev,
    ).toBeGreaterThanOrEqual(regrantCutoff.authRevision);
  });

  it("resolves concurrent creates to the same active room", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    // The partial unique index arbitrates; the losing request must still get
    // the winning room instead of a unique-violation error.
    const results = await Promise.all([
      owner.collaborationRoom.create({ sceneId }),
      owner.collaborationRoom.create({ sceneId }),
      owner.collaborationRoom.create({ sceneId }),
    ]);
    const roomIds = new Set(results.map((room) => room.roomId));
    expect(roomIds.size).toBe(1);
    const rooms = await testDb
      .select()
      .from(schema.collaborationRoom)
      .where(eq(schema.collaborationRoom.sceneId, sceneId));
    expect(rooms).toHaveLength(1);
  });

  it("reports the active room for a scene to authorized callers only", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    expect(await owner.collaborationRoom.getActiveForScene({ sceneId })).toBe(
      null,
    );
    const room = await owner.collaborationRoom.create({
      sceneId,
      linkRole: "viewer",
    });
    expect(
      await owner.collaborationRoom.getActiveForScene({ sceneId }),
    ).toMatchObject({ roomId: room.roomId, role: "owner" });
    expect(
      await callerFor(GUEST).collaborationRoom.getActiveForScene({ sceneId }),
    ).toMatchObject({ roomId: room.roomId, role: "viewer" });
  });
});

describe("collaboration room key check (Plan 34)", () => {
  it("stores the owner's sealed value, returns it from get, and round-trips verification", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });

    // A room the owner has not finished setting up has no value to verify.
    const before = await owner.collaborationRoom.get({ roomId: room.roomId });
    expect(before.keyCheckBase64).toBeNull();

    const roomKey = generateRoomKey();
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey,
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: room.authGeneration,
    });
    await owner.collaborationRoom.setKeyCheck({
      roomId: room.roomId,
      authGeneration: room.authGeneration,
      keyCheckBase64,
    });

    const after = await owner.collaborationRoom.get({ roomId: room.roomId });
    expect(after.keyCheckBase64).toBe(keyCheckBase64);
    // The whole point of the round-trip: the link's key verifies, a wrong
    // (e.g. truncated) link's key does not.
    await expect(
      verifyRoomKeyCheck({
        roomKey,
        roomId: roomIdSchema.parse(room.roomId),
        authGeneration: after.authGeneration,
        keyCheckBase64: after.keyCheckBase64!,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyRoomKeyCheck({
        roomKey: generateRoomKey(),
        roomId: roomIdSchema.parse(room.roomId),
        authGeneration: after.authGeneration,
        keyCheckBase64: after.keyCheckBase64!,
      }),
    ).resolves.toBe(false);
  });

  it("refuses everyone but the owner", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({
      sceneId,
      linkRole: "editor",
    });
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: 1,
    });

    // A link-role editor can edit the scene, but the check value defines what
    // every joiner's key is verified against — owner-only, like the rest of
    // the room's shape.
    await expect(
      callerFor(GUEST).collaborationRoom.setKeyCheck({
        roomId: room.roomId,
        authGeneration: 1,
        keyCheckBase64,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(null).collaborationRoom.setKeyCheck({
        roomId: room.roomId,
        authGeneration: 1,
        keyCheckBase64,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to issue a join token until the key check is armed", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });

    // The client refuses an unverifiable room on its own, but that is a
    // convention; this is the server-side invariant — no token, so no session
    // can ever exist on a room whose key cannot be verified, whatever the
    // client does.
    await expect(
      owner.collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await armKeyCheck(room);
    await expect(
      owner.collaborationRoom.join({
        roomId: room.roomId,
      }),
    ).resolves.toMatchObject({ roomId: room.roomId, role: "owner" });
  });

  it("is immutable within a generation: replacing the value requires rotation", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });
    const roomId = roomIdSchema.parse(room.roomId);
    const first = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId,
      authGeneration: 1,
    });
    await owner.collaborationRoom.setKeyCheck({
      roomId: room.roomId,
      authGeneration: 1,
      keyCheckBase64: first,
    });

    // A second create returns the same active room; letting its fresh key
    // replace the verifier would lock out every holder of the original link.
    const replacement = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId,
      authGeneration: 1,
    });
    await expect(
      owner.collaborationRoom.setKeyCheck({
        roomId: room.roomId,
        authGeneration: 1,
        keyCheckBase64: replacement,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const kept = await owner.collaborationRoom.get({ roomId: room.roomId });
    expect(kept.keyCheckBase64).toBe(first);
  });

  it("refuses a stale generation and a value of the wrong size", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: 2,
    });

    // Sealed for a generation the room is not at: storing it would produce a
    // value no current link could ever verify against.
    await expect(
      owner.collaborationRoom.setKeyCheck({
        roomId: room.roomId,
        authGeneration: 2,
        keyCheckBase64,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // Same base64 length as a real value, different decoded size: caught by
    // the decoded-length check that backs the pinned column constraint.
    await expect(
      owner.collaborationRoom.setKeyCheck({
        roomId: room.roomId,
        authGeneration: 1,
        keyCheckBase64: Buffer.from(
          new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES + 1).fill(1),
        ).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is cleared by rotation and recomputed for the new generation", async () => {
    const sceneId = await createScene(OWNER);
    const owner = callerFor(OWNER);
    const room = await owner.collaborationRoom.create({ sceneId });
    const oldValue = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: 1,
    });
    await owner.collaborationRoom.setKeyCheck({
      roomId: room.roomId,
      authGeneration: 1,
      keyCheckBase64: oldValue,
    });

    const rotated = await owner.collaborationRoom.rotateGeneration({
      roomId: room.roomId,
    });
    // The stored value belonged to generation 1 and its retired key; a row
    // pairing generation 2 with it would refuse every link, right and wrong.
    const cleared = await owner.collaborationRoom.get({ roomId: room.roomId });
    expect(cleared.keyCheckBase64).toBeNull();

    // The rotate flow recomputes with the fresh key; the new link verifies.
    const newKey = generateRoomKey();
    const newValue = await sealRoomKeyCheck({
      roomKey: newKey,
      roomId: roomIdSchema.parse(room.roomId),
      authGeneration: rotated.authGeneration,
    });
    await owner.collaborationRoom.setKeyCheck({
      roomId: room.roomId,
      authGeneration: rotated.authGeneration,
      keyCheckBase64: newValue,
    });
    const recomputed = await owner.collaborationRoom.get({
      roomId: room.roomId,
    });
    expect(recomputed.keyCheckBase64).toBe(newValue);
    await expect(
      verifyRoomKeyCheck({
        roomKey: newKey,
        roomId: roomIdSchema.parse(room.roomId),
        authGeneration: rotated.authGeneration,
        keyCheckBase64: recomputed.keyCheckBase64!,
      }),
    ).resolves.toBe(true);
  });
});
