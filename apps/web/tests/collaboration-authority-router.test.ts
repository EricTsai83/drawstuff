import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({
  env: {
    COLLAB_IDENTITY_SECRET: "identity-service-test-secret-000000001",
    COLLAB_AUTHORITY_SECRET: "gateway-service-test-secret-000000001",
    COLLAB_CONTROL_URL: "https://gateway.test",
    COLLAB_ROOMS_DISABLED: "off",
  },
  identity: vi.fn(),
  gateway: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/env", () => ({ env: doubles.env }));
vi.mock("@/server/collab/authority-identity", () => ({
  issueAuthorityIdentity: doubles.identity,
}));
vi.mock("@/server/collab/authority-gateway", () => ({
  callAuthorityGateway: doubles.gateway,
}));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: doubles.limit,
  rateLimitMetadataOf: () => null,
}));
import { collaborationAuthorityRouter } from "@/server/api/routers/collaboration-authority";
import type { createTRPCContext } from "@/server/api/trpc";
import { AdapterError } from "@/server/collab/authority-storage";

// Only request plumbing is synthetic; these tests exercise the real protected procedure and schema.
const database = {};
function caller(subject: string | null = "owner") {
  return collaborationAuthorityRouter.createCaller({
    db: database,
    headers: new Headers(),
    auth: subject
      ? { user: { id: subject }, session: { id: "live-session" } }
      : null,
  } as unknown as Awaited<ReturnType<typeof createTRPCContext>>);
}
function request() {
  return {
    v: 1 as const,
    action: "get-state" as const,
    roomId: "authority-router-room",
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  doubles.env.COLLAB_ROOMS_DISABLED = "off";
  doubles.env.COLLAB_IDENTITY_SECRET = "identity-service-test-secret-000000001";
  doubles.identity.mockResolvedValue({
    proof: "live-proof",
    expiresAt: Date.now() + 60_000,
  });
  doubles.gateway.mockResolvedValue({ state: "initializing" });
  doubles.limit.mockResolvedValue(undefined);
});
describe("formal authorization router", () => {
  it("rejects anonymous requests and caller-selected identity fields before issuing a proof", async () => {
    await expect(caller(null).execute(request())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller().execute({
        ...request(),
        actor: { subject: "someone-else" },
      } as ReturnType<typeof request>),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(doubles.identity).not.toHaveBeenCalled();
    expect(doubles.gateway).not.toHaveBeenCalled();
  });
  it("binds proof issuance and rate limits to the logged-in session and forwards only that proof", async () => {
    const input = request();
    await caller().execute(input);
    expect(doubles.limit).toHaveBeenCalledWith({
      operation: "join",
      identifier: "owner",
    });
    expect(doubles.identity).toHaveBeenCalledWith(
      database,
      {
        subject: "owner",
        sessionId: "live-session",
        roomId: input.roomId,
      },
      doubles.env.COLLAB_IDENTITY_SECRET,
    );
    expect(doubles.gateway).toHaveBeenCalledWith(
      {
        url: doubles.env.COLLAB_CONTROL_URL,
        secret: doubles.env.COLLAB_AUTHORITY_SECRET,
      },
      "live-proof",
      input,
    );
    expect(await caller().identity({ roomId: input.roomId })).toMatchObject({
      proof: "live-proof",
      relayUrl: `wss://gateway.test/v1/rooms/${input.roomId}/socket`,
    });
  });
  it("fails closed on disabled/unconfigured service, distinguishes identity refusal from outages, and never forwards", async () => {
    doubles.env.COLLAB_ROOMS_DISABLED = "on";
    await expect(caller().execute(request())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    doubles.env.COLLAB_ROOMS_DISABLED = "off";
    doubles.env.COLLAB_IDENTITY_SECRET = "";
    await expect(
      caller().identity({ roomId: request().roomId }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(doubles.identity).not.toHaveBeenCalled();
    doubles.env.COLLAB_IDENTITY_SECRET =
      "identity-service-test-secret-000000001";
    doubles.identity.mockRejectedValue(new AdapterError("fence-mismatch"));
    await expect(caller().execute(request())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    doubles.identity.mockRejectedValue(new Error("database unavailable"));
    await expect(
      caller().identity({ roomId: request().roomId }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(doubles.gateway).not.toHaveBeenCalled();
  });
});
