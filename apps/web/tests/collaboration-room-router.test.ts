import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  rateLimitMetadataOf: () => null,
}));
const fake = vi.hoisted(() => ({
  identity: vi.fn(),
  gateway: vi.fn(),
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
import { collaborationRoomRouter } from "@/server/api/routers/collaboration-room";
import type { createTRPCContext } from "@/server/api/trpc";
function caller(subject: string | null = "owner") {
  return collaborationRoomRouter.createCaller({
    db: {},
    headers: new Headers(),
    auth: subject
      ? { user: { id: subject }, session: { id: "session" } }
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
  authGeneration: 1,
  authRevision: 1,
  authorityEpoch: 1,
  initializationDeadline: Date.now() + 60_000,
  keyCheck: null,
  members: [
    {
      userId: "owner",
      name: "owner@example.com",
      role: "owner",
      revoked: false,
      lastJoinedAt: null,
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
    expect(await caller().get({ roomId: "room-panel" })).toEqual(state);
    expect(fake.identity).toHaveBeenCalledWith(
      {},
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
  it("never falls back to the display DB when Room refuses", async () => {
    fake.gateway.mockRejectedValue(new Error("forbidden"));
    await expect(caller().get({ roomId: "room-panel" })).rejects.toThrow(
      "forbidden",
    );
  });
});
