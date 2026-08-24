// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TOKEN_SECRET = "web-test-room-token-secret-0123456789";

/**
 * Mutable env double: the unconfigured-URL case is part of the contract (the
 * DO gateway may not be provisioned during the 0%-traffic window), so tests
 * flip the URL on and off rather than mocking the module twice.
 */
const testEnv = vi.hoisted(
  (): {
    COLLAB_JOIN_TOKEN_SECRET: string;
    COLLAB_DO_CONTROL_URL: string | undefined;
  } => ({
    COLLAB_JOIN_TOKEN_SECRET: "web-test-room-token-secret-0123456789",
    COLLAB_DO_CONTROL_URL: "https://do-gateway.test",
  }),
);
vi.mock("@/env", () => ({ env: testEnv }));

import { DO_GATEWAY_CONTROL_PATH } from "@drawstuff/collaboration/relay-control";
import { verifyRoomControlToken } from "@drawstuff/collaboration/room-token";

import { pushDoRoomControl } from "@/server/collab/do-control";

const PUSH_PARAMS = {
  roomId: "room-do-control",
  authGeneration: 3,
  authRevision: 7,
  now: new Date("2026-08-24T10:00:00Z"),
  action: "revoke-member",
  userId: "user-revoked",
} as const;

function fetchStub(response: Response): ReturnType<typeof vi.fn> {
  const stub = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", stub);
  return stub;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  testEnv.COLLAB_DO_CONTROL_URL = "https://do-gateway.test";
});

describe("pushDoRoomControl", () => {
  it("POSTs one signed control token to the gateway control path", async () => {
    const stub = fetchStub(Response.json({ appliedRevision: 7, closed: 2 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({ enforced: true, closedSessions: 2 });

    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`https://do-gateway.test${DO_GATEWAY_CONTROL_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // The body is exactly one token, and the token carries the verified
    // claims of this push — same audience and claims as the relay path.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["token"]);
    const verified = verifyRoomControlToken({
      token: body.token as string,
      secret: TOKEN_SECRET,
      nowSeconds: Math.floor(PUSH_PARAMS.now.getTime() / 1000),
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toMatchObject({
        action: "revoke-member",
        rid: "room-do-control",
        gen: 3,
        arev: 7,
        sub: "user-revoked",
      });
    }
  });

  it("reports non-enforcement when the gateway URL is not configured", async () => {
    const stub = fetchStub(Response.json({ appliedRevision: 7, closed: 0 }));
    testEnv.COLLAB_DO_CONTROL_URL = undefined;
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      reason: "DO control URL is not configured",
    });
    expect(stub).not.toHaveBeenCalled();
  });

  it("reports non-enforcement on a non-OK status", async () => {
    fetchStub(Response.json({ error: "unauthorized" }, { status: 401 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      reason: "DO gateway responded 401",
    });
  });

  it("reports non-enforcement on a 200 outside the response contract", async () => {
    fetchStub(Response.json({ action: "end-room", closed: 1 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      reason: "malformed DO gateway response",
    });
  });

  it("reports non-enforcement when the gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      reason: "connect ECONNREFUSED",
    });
  });

  it("tolerates optional fields a newer gateway adds to the response", async () => {
    fetchStub(
      Response.json({ appliedRevision: 9, closed: 0, futureField: true }),
    );
    const result = await pushDoRoomControl({
      ...PUSH_PARAMS,
      action: "end-room",
    });
    expect(result).toEqual({ enforced: true, closedSessions: 0 });
  });
});
