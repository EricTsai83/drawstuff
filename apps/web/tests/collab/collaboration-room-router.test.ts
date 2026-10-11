import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  rateLimitMetadataOf: () => null,
}));
const fake = vi.hoisted(() => ({
  identity: vi.fn(),
  gateway: vi.fn(),
  list: vi.fn(),
  names: [] as { id: string; email: string; name: string }[],
  env: {
    COLLAB_IDENTITY_SECRET: "i".repeat(32),
    COLLAB_AUTHORITY_SECRET: "a".repeat(32),
    COLLAB_CONTROL_URL: "https://gateway.test",
  },
}));
vi.mock("@/env", () => ({ env: fake.env }));
vi.mock("@/server/collab/authority-identity", () => ({
  issueAuthorityIdentity: fake.identity,
}));
vi.mock("@/server/collab/authority-gateway", () => ({
  callAuthorityGateway: fake.gateway,
}));
vi.mock("@/server/collab/authority-projection", () => ({
  listProjectedRooms: fake.list,
}));
import { collaborationRoomRouter } from "@/server/api/routers/collaboration-room";
import type { createTRPCContext } from "@/server/api/trpc";
/** Answers only the member-name lookup; every other read goes through Room. */
const db = {
  select: () => ({
    from: () => ({ where: () => Promise.resolve(fake.names) }),
  }),
};
function caller(
  subject: string | null = "owner",
  user: { email?: string; emailVerified?: boolean } = {},
) {
  return collaborationRoomRouter.createCaller({
    db,
    headers: new Headers(),
    auth: subject
      ? { user: { id: subject, ...user }, session: { id: "session" } }
      : null,
  } as unknown as Awaited<ReturnType<typeof createTRPCContext>>);
}
const state = {
  roomId: "room-panel",
  state: "initializing",
  role: "owner",
  sceneId: null,
  label: "Independent",
  linkRole: "none",
  authRevision: 1,
  authorityEpoch: 1,
  initializationDeadline: Date.now() + 60_000,
  members: [
    {
      userId: "owner",
      email: "owner@example.com",
      role: "owner",
      lastJoinedAt: null,
    },
    {
      userId: "former",
      email: "former@example.com",
      role: null,
      lastJoinedAt: 1,
    },
  ],
  nextCursor: null,
  nextEmailCursor: null,
  allowlist: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.identity.mockResolvedValue({ proof: "fresh-session-proof" });
  fake.gateway.mockResolvedValue(state);
  fake.names = [];
});
describe("Room-authorized management reads", () => {
  it("refuses anonymous users and has no DB permission writers or legacy token issuer", async () => {
    await expect(
      caller(null).get({ roomId: "room-panel" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(Object.keys(collaborationRoomRouter._def.procedures).sort()).toEqual(
      ["get", "list"],
    );
    expect(fake.identity).not.toHaveBeenCalled();
  });
  it("uses a fresh session identity and the Room even while initializing", async () => {
    expect(await caller().get({ roomId: "room-panel" })).toEqual({
      ...state,
      members: state.members.map((member) => ({ ...member, name: null })),
    });
    expect(fake.identity).toHaveBeenCalledWith(
      db,
      { subject: "owner", sessionId: "session", roomId: "room-panel" },
      fake.env.COLLAB_IDENTITY_SECRET,
    );
    expect(fake.gateway.mock.calls[0]?.[2]).toMatchObject({
      action: "get-management",
      roomId: "room-panel",
    });
  });
  it("passes a bounded member cursor and fails on an invalid Room response", async () => {
    await caller().get({ roomId: "room-panel", cursor: "member-100" });
    expect(fake.gateway.mock.calls[0]?.[2]).toMatchObject({
      cursor: "member-100",
    });
    fake.gateway.mockResolvedValue({ ...state, role: "admin" });
    await expect(caller().get({ roomId: "room-panel" })).rejects.toThrow();
  });
  it("names members from their accounts, leaving a blank name as email only", async () => {
    fake.names = [
      { id: "owner", email: "owner@example.com", name: " Ada Owner " },
      { id: "former", email: "former@example.com", name: "  " },
    ];
    const { members } = await caller().get({ roomId: "room-panel" });
    expect(members.map(({ userId, name }) => ({ userId, name }))).toEqual([
      { userId: "owner", name: "Ada Owner" },
      { userId: "former", name: null },
    ]);
  });
  it("names an opened invitation by its account email, whatever member page is loaded", async () => {
    fake.gateway.mockResolvedValue({
      ...state,
      members: [],
      allowlist: [
        { email: "Amy@Example.com", role: "editor", lastJoinedAt: 1 },
        { email: "bob@example.com", role: "viewer", lastJoinedAt: null },
      ],
    });
    fake.names = [
      { id: "amy", email: "amy@example.com", name: "Amy" },
      { id: "bob", email: "bob@example.com", name: "Bob" },
    ];
    const { allowlist } = await caller().get({ roomId: "room-panel" });
    // Bob has not opened the room, so his account name stays private.
    expect(allowlist.map(({ email, name }) => ({ email, name }))).toEqual([
      { email: "Amy@Example.com", name: "Amy" },
      { email: "bob@example.com", name: null },
    ]);
  });
  it("never falls back to the display DB when Room refuses", async () => {
    fake.gateway.mockRejectedValue(new Error("forbidden"));
    await expect(caller().get({ roomId: "room-panel" })).rejects.toThrow(
      "forbidden",
    );
  });
});
describe("room list", () => {
  it("matches invitations by the verified, normalized email only", async () => {
    fake.list.mockResolvedValue({ rooms: [], nextCursor: null });
    await caller("owner", {
      email: " Owner@Example.com ",
      emailVerified: true,
    }).list({ section: "mine" });
    expect(fake.list).toHaveBeenLastCalledWith(
      db,
      { subject: "owner", email: "owner@example.com" },
      { section: "mine", limit: 30 },
    );
    await caller("owner", {
      email: "owner@example.com",
      emailVerified: false,
    }).list({ section: "link" });
    expect(fake.list).toHaveBeenLastCalledWith(
      db,
      { subject: "owner", email: null },
      { section: "link", limit: 30 },
    );
  });
});
