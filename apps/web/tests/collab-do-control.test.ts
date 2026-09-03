// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TOKEN_SECRET = "web-test-room-token-secret-0123456789";

/**
 * Mutable env double for the permanent DO gateway control origin.
 */
const testEnv = vi.hoisted(
  (): {
    COLLAB_JOIN_TOKEN_SECRET: string;
    COLLAB_CONTROL_URL: string;
  } => ({
    COLLAB_JOIN_TOKEN_SECRET: "web-test-room-token-secret-0123456789",
    COLLAB_CONTROL_URL: "https://do-gateway.test",
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
  testEnv.COLLAB_CONTROL_URL = "https://do-gateway.test";
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

  it("reports non-enforcement on a non-OK status", async () => {
    fetchStub(Response.json({ error: "unauthorized" }, { status: 401 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      failure: "rejected",
      reason: "DO gateway responded 401",
    });
  });

  it("marks a 422 rejection contract terminal, other 4xx retryable", async () => {
    fetchStub(
      Response.json(
        { error: "control-rejected", code: "schema-skew" },
        { status: 422 },
      ),
    );
    expect(await pushDoRoomControl(PUSH_PARAMS)).toEqual({
      enforced: false,
      failure: "rejected",
      terminal: true,
      reason: "DO gateway rejected the command: schema-skew",
    });

    // A 422 without the contract body is not the gateway speaking.
    fetchStub(Response.json({ error: "something else" }, { status: 422 }));
    expect(await pushDoRoomControl(PUSH_PARAMS)).toEqual({
      enforced: false,
      failure: "rejected",
      reason: "DO gateway responded 422",
    });
  });

  it("reports non-enforcement on a 200 outside the response contract", async () => {
    fetchStub(Response.json({ action: "end-room", closed: 1 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      failure: "malformed-response",
      reason: "malformed DO gateway response",
    });
  });

  it("classifies a 200 with a non-JSON body as malformed, not unreachable", async () => {
    fetchStub(new Response("<html>gateway error page</html>", { status: 200 }));
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      failure: "malformed-response",
      reason: "malformed DO gateway response",
    });
  });

  it("keeps a timeout during the body read classified as transport, not malformed", async () => {
    // 2xx headers arrived, but the overall AbortSignal.timeout fired while
    // the body was being consumed: `response.json()` rejects with a
    // TimeoutError, which is an ambiguous transport outcome — resendable —
    // not a contract violation.
    const timeoutError = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(timeoutError),
      }),
    );
    const result = await pushDoRoomControl(PUSH_PARAMS);
    expect(result).toEqual({
      enforced: false,
      failure: "timeout",
      reason: "The operation timed out.",
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
      failure: "unreachable",
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
