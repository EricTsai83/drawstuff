import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RateLimits from "@/server/rate-limit/collaboration";
vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_BASE_URL: "https://app.test",
    COLLAB_CONTROL_URL: "https://gateway.test",
    COLLAB_IDENTITY_SECRET: "identity-test-secret-000000000000001",
    COLLAB_AUTHORITY_SECRET: "gateway-test-secret-000000000000001",
    COLLAB_ROOMS_DISABLED: "off",
    UPSTASH_REDIS_REST_URL: "https://ratelimit.invalid",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
  },
  session: vi.fn(),
  identity: vi.fn(),
  gateway: vi.fn(),
  check: vi.fn(),
  enforce: vi.fn(),
}));
vi.mock("@/env", () => ({ env: doubles.env }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: doubles.session } },
}));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/collab/authority-identity", () => ({
  issueAuthorityIdentity: doubles.identity,
}));
vi.mock("@/server/collab/authority-gateway", () => ({
  callAuthorityGateway: doubles.gateway,
}));
vi.mock("@/server/rate-limit/collaboration", async (original) => ({
  ...(await original<typeof RateLimits>()),
  checkCollaborationRateLimit: doubles.check,
  enforceCollaborationRateLimit: doubles.enforce,
}));
import { POST } from "@/app/api/collaboration/snapshot/route";
import { AdapterError } from "@/server/collab/authority-storage";
import { enforceCollaborationRateLimitDecision } from "@/server/rate-limit/collaboration";
import {
  SNAPSHOT_RECEIPT_HEADER,
  SNAPSHOT_REQUEST_HEADER,
  type ContentResult,
} from "@drawstuff/collaboration/authority";
import {
  MAX_SNAPSHOT_BYTES,
  encodeCollaborationSnapshot,
  decodeCollaborationSnapshot,
  snapshotChecksum,
} from "@drawstuff/collaboration/snapshot";
import {
  createBinarySnapshotClient,
  SNAPSHOT_INTENT_HEADER,
  SnapshotHttpError,
} from "@/lib/collab/snapshot-http";
import { rateLimitRetryAfterMs } from "@/lib/collab/rate-limit";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";

const roomId = roomIdSchema.parse("snapshot-http-room");
const upstream = vi.fn<typeof fetch>();
const state = {
  roomId,
  state: "ready",
  role: "editor",
  sceneId: null,
  label: "",
  linkRole: "editor",
  authRevision: 1,
  authorityEpoch: 1,
  initializationDeadline: Date.now() + 900_000,
};
const limited = {
  status: "limited" as const,
  reset: Date.now() + 2_001,
  retryAfterMs: 2_001,
};
function read() {
  return {
    action: "read" as const,
    v: 1 as const,
    roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  };
}
async function write(bytes = new Uint8Array(32).fill(7)) {
  return {
    bytes,
    request: {
      action: "write" as const,
      operation: {
        v: 1 as const,
        roomId,
        operationId: crypto.randomUUID(),
        deadline: Date.now() + 55_000,
        kind: "snapshot-put" as const,
        authorityEpoch: 1,
        expectedRevision: 0,
        checksum: await snapshotChecksum(bytes),
      },
    },
  };
}
function http(
  input: unknown,
  body?: BodyInit,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request("https://app.test/api/collaboration/snapshot", {
    method: "POST",
    headers: {
      origin: "https://app.test",
      "content-type": "application/octet-stream",
      [SNAPSHOT_REQUEST_HEADER]: JSON.stringify(input),
      ...headers,
    },
    body,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
async function binary(bytes: Uint8Array<ArrayBuffer>, overrides = {}) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
        roomId,
        authorityEpoch: 1,
        revision: 1,
        byteLength: bytes.byteLength,
        checksum: await snapshotChecksum(bytes),
        ...overrides,
      }),
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  doubles.env.COLLAB_ROOMS_DISABLED = "off";
  doubles.env.COLLAB_CONTROL_URL = "https://gateway.test";
  doubles.env.COLLAB_IDENTITY_SECRET = "identity-test-secret-000000000000001";
  doubles.session.mockResolvedValue({
    user: { id: "owner" },
    session: { id: "live-session" },
  });
  doubles.identity.mockResolvedValue({ proof: "server-only-proof" });
  doubles.gateway.mockResolvedValue(state);
  doubles.check.mockResolvedValue({ status: "allowed" });
  doubles.enforce.mockResolvedValue(undefined);
  upstream
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ status: "written", revision: 1 }),
    );
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("authenticated binary snapshot web ingress", () => {
  it("rejects cross-origin, missing origin, spoofed actor/proof, wrong media type and oversized metadata before authentication", async () => {
    for (const req of [
      http(read(), undefined, {
        origin: "https://evil.test",
        host: "app.test",
      }),
      http(read(), undefined, { origin: "" }),
      http(read(), undefined, { "sec-fetch-site": "cross-site" }),
      http({ ...read(), actor: { subject: "owner" } }),
      http({ proof: "browser-proof", request: read() }),
      http(read(), undefined, { "content-type": "application/json" }),
      http(read(), undefined, { [SNAPSHOT_REQUEST_HEADER]: " ".repeat(8_193) }),
    ])
      expect((await POST(req)).status).toBeOneOf([400, 403]);
    expect(doubles.session).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("fails closed for anonymous, disabled, missing credentials, insecure URL, and live identity refusal without reading a body", async () => {
    let pulls = 0;
    const body = () =>
      new ReadableStream<Uint8Array>(
        {
          pull() {
            pulls++;
          },
        },
        { highWaterMark: 0 },
      );
    doubles.session.mockResolvedValue(null);
    expect((await POST(http(read(), body()))).status).toBe(401);
    doubles.session.mockResolvedValue({
      user: { id: "owner" },
      session: { id: "live-session" },
    });
    doubles.env.COLLAB_ROOMS_DISABLED = "on";
    expect((await POST(http(read(), body()))).status).toBe(503);
    doubles.env.COLLAB_ROOMS_DISABLED = "off";
    doubles.env.COLLAB_IDENTITY_SECRET = "";
    expect((await POST(http(read(), body()))).status).toBe(503);
    doubles.env.COLLAB_IDENTITY_SECRET = "identity-test-secret-000000000000001";
    doubles.env.COLLAB_CONTROL_URL = "http://gateway.test";
    expect((await POST(http(read(), body()))).status).toBe(503);
    doubles.env.COLLAB_CONTROL_URL = "https://gateway.test";
    doubles.identity.mockRejectedValue(new AdapterError("fence-mismatch"));
    expect((await POST(http(read(), body()))).status).toBe(403);
    doubles.identity.mockRejectedValue(new Error("private database details"));
    const unavailable = await POST(http(read(), body()));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private database");
    expect(pulls).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("uses the current session's live proof and forwards only private capability, strict intent and raw bytes", async () => {
    const f = await write();
    const response = await POST(
      http(f.request, f.bytes, {
        cookie: "private-cookie",
        authorization: "Bearer browser-token",
      }),
    );
    expect(await response.json()).toEqual({ status: "written", revision: 1 });
    expect(doubles.identity).toHaveBeenCalledWith(
      {},
      { subject: "owner", sessionId: "live-session", roomId },
      doubles.env.COLLAB_IDENTITY_SECRET,
    );
    expect(doubles.enforce).toHaveBeenCalledWith({
      operation: "snapshot-request",
      identifier: "owner",
    });
    expect(doubles.check).toHaveBeenCalledWith({
      operation: "snapshot-put",
      identifier: roomId,
    });
    const [url, init] = upstream.mock.calls[0]!;
    expect(
      url instanceof URL ? url.href : url instanceof Request ? url.url : url,
    ).toBe("https://gateway.test/v1/snapshot");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${doubles.env.COLLAB_AUTHORITY_SECRET}`,
    );
    expect(headers.has("cookie")).toBe(false);
    expect(JSON.parse(headers.get(SNAPSHOT_REQUEST_HEADER)!)).toEqual({
      proof: "server-only-proof",
      request: f.request,
    });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(f.bytes);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("refuses viewers and non-owner reset before spending the room write budget", async () => {
    const f = await write();
    doubles.gateway.mockResolvedValue({ ...state, role: "viewer" });
    expect((await POST(http(f.request, f.bytes))).status).toBe(403);
    doubles.gateway.mockResolvedValue(state);
    const reset = {
      action: "write",
      operation: {
        ...f.request.operation,
        kind: "snapshot-reset",
        checksum: await snapshotChecksum(new Uint8Array()),
      },
    };
    expect((await POST(http(reset))).status).toBe(403);
    expect(doubles.check).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("keeps bounded leave reserve and machine-readable 429, including degraded primary decisions", async () => {
    const f = await write();
    doubles.check.mockResolvedValue(limited);
    let response = await POST(http(f.request, f.bytes));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({
      code: "rate-limited",
      rateLimit: { retryAfterMs: 2_001 },
    });
    response = await POST(
      http(f.request, f.bytes, { [SNAPSHOT_INTENT_HEADER]: "leave" }),
    );
    expect(response.status).toBe(200);
    expect(doubles.enforce).toHaveBeenCalledWith({
      operation: "snapshot-finalize",
      identifier: JSON.stringify([roomId, "owner"]),
    });
    doubles.check.mockResolvedValue({ status: "degraded" });
    doubles.enforce.mockClear();
    expect(
      (
        await POST(
          http(f.request, f.bytes, { [SNAPSHOT_INTENT_HEADER]: "leave" }),
        )
      ).status,
    ).toBe(200);
    expect(doubles.enforce).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "snapshot-finalize" }),
    );
    doubles.enforce.mockImplementation(() =>
      enforceCollaborationRateLimitDecision(limited),
    );
    expect((await POST(http(read()))).status).toBe(429);
  });
  it("permits initializing owners and owner reset, but does not confirm a write refused after the role preflight", async () => {
    const f = await write();
    doubles.gateway.mockResolvedValue({
      ...state,
      state: "initializing",
      role: "owner",
    });
    expect((await POST(http(f.request, f.bytes))).status).toBe(200);
    const reset = {
      action: "write",
      operation: {
        ...f.request.operation,
        kind: "snapshot-reset",
        checksum: await snapshotChecksum(new Uint8Array()),
      },
    };
    expect((await POST(http(reset))).status).toBe(200);
    upstream.mockResolvedValueOnce(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const refused = await POST(http(f.request, f.bytes));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ ok: false, code: "forbidden" });
  });
  it("checks actual streamed bytes, checksum and emptiness independently of Content-Length; controls cannot carry bytes", async () => {
    const f = await write();
    const cancelled = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SNAPSHOT_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelled,
    });
    expect(
      (await POST(http(f.request, oversized, { "content-length": "1" })))
        .status,
    ).toBe(413);
    expect(cancelled).toHaveBeenCalled();
    expect((await POST(http(f.request, f.bytes.slice(1)))).status).toBe(400);
    const empty = await write(new Uint8Array());
    expect((await POST(http(empty.request, empty.bytes))).status).toBe(400);
    expect(
      (
        await POST(
          http(
            {
              ...f.request,
              operation: { ...f.request.operation, checksum: "0".repeat(64) },
            },
            f.bytes,
          ),
        )
      ).status,
    ).toBe(400);
    expect((await POST(http(read(), new Uint8Array(1)))).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("preserves reset absence watermarks and forwards pending/query/cancel without spending write budgets", async () => {
    upstream.mockResolvedValue(
      Response.json(
        { error: "not-found" },
        {
          status: 404,
          headers: {
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
              roomId,
              authorityEpoch: 3,
              revision: 7,
            }),
          },
        },
      ),
    );
    const response = await POST(http(read()));
    expect(response.status).toBe(404);
    expect(
      JSON.parse(response.headers.get(SNAPSHOT_RECEIPT_HEADER)!),
    ).toMatchObject({ revision: 7, authorityEpoch: 3 });
    const f = await write();
    for (const action of ["query", "cancel"] as const) {
      upstream.mockResolvedValueOnce(Response.json({ status: "pending" }));
      expect(
        await (
          await POST(
            http({
              action,
              operation: { ...f.request.operation, deadline: Date.now() - 1 },
            }),
          )
        ).json(),
      ).toEqual({ status: "pending" });
    }
    expect(doubles.check).not.toHaveBeenCalled();
    expect(doubles.gateway).not.toHaveBeenCalled();
  });
  it("does not expose malformed, oversized, redirected or unbound upstream replies as confirmation", async () => {
    const f = await write();
    for (const reply of [
      Response.json({ status: "written", revision: 99 }),
      Response.json({ status: "written", revision: 1, proof: "private-proof" }),
      new Response(" ".repeat(65_537), {
        headers: { "content-type": "application/json" },
      }),
      Response.json(
        { error: "forbidden", secret: "private-secret" },
        { status: 403 },
      ),
      new Response(null, { status: 302 }),
    ]) {
      upstream.mockResolvedValueOnce(reply);
      const response = await POST(http(f.request, f.bytes));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, code: "unavailable" });
    }
    upstream.mockResolvedValueOnce(
      await binary(f.bytes, { roomId: "other-room" }),
    );
    expect((await POST(http(read()))).status).toBe(503);
  });
  it("cancels stalled uploads at the deadline and stalled downloads when the browser aborts", async () => {
    vi.useFakeTimers();
    const f = await write();
    const cancelUpload = vi.fn();
    const promise = POST(
      http(f.request, new ReadableStream<Uint8Array>({ cancel: cancelUpload })),
    );
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await promise).status).toBe(503);
    expect(cancelUpload).toHaveBeenCalled();
    const cancelDownload = vi.fn();
    const good = await binary(f.bytes);
    upstream.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelDownload }), {
        headers: good.headers,
      }),
    );
    const controller = new AbortController();
    const response = await POST(http(read(), undefined, {}, controller.signal));
    const pending = response.arrayBuffer();
    const rejection = expect(pending).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(cancelDownload).toHaveBeenCalled();
  });
});

describe("binary snapshot browser transport", () => {
  it("round-trips the maximum legal snapshot through the real web handler without Base64", async () => {
    const encoded = encodeCollaborationSnapshot({ roomId, elements: [] });
    if (!encoded.ok) throw new Error("invalid-fixture");
    // JSON whitespace padding reaches the exact byte ceiling while remaining
    // a valid snapshot that can be decoded after transport.
    const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES).fill(32);
    bytes.set(encoded.bytes);
    const f = await write(bytes);
    const bridge: typeof fetch = (_url, init) =>
      POST(
        http(
          JSON.parse(
            new Headers(init?.headers).get(SNAPSHOT_REQUEST_HEADER)!,
          ) as unknown,
          init?.body ?? undefined,
          {
            [SNAPSHOT_INTENT_HEADER]: new Headers(init?.headers).get(
              SNAPSHOT_INTENT_HEADER,
            )!,
          },
          init?.signal ?? undefined,
        ),
      );
    const client = createBinarySnapshotClient(bridge);
    expect(await client.write(f.request.operation, f.bytes)).toEqual({
      status: "written",
      revision: 1,
    });
    upstream.mockResolvedValueOnce(await binary(f.bytes));
    const result = await client.read(read());
    expect(result.found).toBe(true);
    expect(result.bytes?.byteLength).toBe(MAX_SNAPSHOT_BYTES);
    expect(await snapshotChecksum(result.bytes!)).toBe(
      f.request.operation.checksum,
    );
    expect(decodeCollaborationSnapshot(result.bytes!, { roomId }).ok).toBe(
      true,
    );
  });
  it("preserves the exact operation on retry/query/cancel and never turns pending into written", async () => {
    const f = await write();
    const requests: { metadata: unknown; bytes: Uint8Array }[] = [];
    const replies: ContentResult[] = [
      { status: "pending" },
      { status: "pending" },
      { status: "written", revision: 1 },
      { status: "cancelled" },
    ];
    const client = createBinarySnapshotClient(async (_url, init) => {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      requests.push({
        metadata: JSON.parse(
          new Headers(init?.headers).get(SNAPSHOT_REQUEST_HEADER)!,
        ) as unknown,
        bytes: new Uint8Array(init?.body as ArrayBuffer),
      });
      return Response.json(replies.shift());
    });
    expect(await client.write(f.request.operation, f.bytes)).toEqual({
      status: "pending",
    });
    expect(await client.query(f.request.operation)).toEqual({
      status: "pending",
    });
    expect(await client.write(f.request.operation, f.bytes)).toEqual({
      status: "written",
      revision: 1,
    });
    expect(await client.cancel(f.request.operation)).toEqual({
      status: "cancelled",
    });
    expect(requests.map((request) => request.metadata)).toEqual([
      f.request,
      { action: "query", operation: f.request.operation },
      f.request,
      { action: "cancel", operation: f.request.operation },
    ]);
    expect(requests[0]!.bytes).toEqual(requests[2]!.bytes);
    expect(requests[1]!.bytes.byteLength).toBe(0);
  });
  it("keeps an empty snapshot's revision and classifies HTTP rate limits for existing retry scheduling", async () => {
    const client = createBinarySnapshotClient(async () =>
      Response.json(
        { ok: false, code: "not-found" },
        {
          status: 404,
          headers: {
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
              roomId,
              authorityEpoch: 2,
              revision: 3,
            }),
          },
        },
      ),
    );
    expect(await client.read(read())).toMatchObject({
      found: false,
      bytes: null,
      receipt: { revision: 3 },
    });
    const limitedClient = createBinarySnapshotClient(async () =>
      Response.json(
        {
          ok: false,
          code: "rate-limited",
          rateLimit: {
            reset: limited.reset,
            retryAfterMs: limited.retryAfterMs,
          },
        },
        { status: 429 },
      ),
    );
    const error: unknown = await limitedClient
      .read(read())
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SnapshotHttpError);
    expect(rateLimitRetryAfterMs(error)).toBe(2_001);
  });
  it("refuses mismatched receipts, corrupt/truncated/oversized bytes and false written revisions", async () => {
    const f = await write();
    const good = await binary(f.bytes);
    for (const response of [
      await binary(f.bytes, { roomId: "different-room" }),
      await binary(f.bytes, { checksum: "0".repeat(64) }),
      new Response(f.bytes.slice(1), { headers: good.headers }),
      new Response(new Uint8Array(f.bytes.byteLength + 1), {
        headers: good.headers,
      }),
    ])
      await expect(
        createBinarySnapshotClient(async () => response).read(read()),
      ).rejects.toThrow();
    await expect(
      createBinarySnapshotClient(async () =>
        Response.json({ status: "written", revision: 2 }),
      ).write(f.request.operation, f.bytes),
    ).rejects.toThrow();
  });
  it("rejects locally oversized bodies and aborts a stalled response without confirmation", async () => {
    const f = await write();
    const transport = vi.fn<typeof fetch>();
    const client = createBinarySnapshotClient(transport);
    await expect(
      client.write(f.request.operation, new Uint8Array(MAX_SNAPSHOT_BYTES + 1)),
    ).rejects.toMatchObject({ status: 413 });
    expect(transport).not.toHaveBeenCalled();
    const cancelled = vi.fn();
    const good = await binary(f.bytes);
    transport.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
        headers: good.headers,
      }),
    );
    const abort = new AbortController();
    const pending = client.read(read(), abort.signal);
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(transport).toHaveBeenCalled());
    abort.abort();
    await rejection;
    expect(cancelled).toHaveBeenCalled();
  });
});
