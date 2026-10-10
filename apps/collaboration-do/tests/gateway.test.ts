import { env, listDurableObjectIds, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { settleRoomEvents } from "./support/room-socket.ts";

afterEach(settleRoomEvents);

const BASE = "https://collaboration-gateway.test";
const ALLOWED_ORIGIN = "http://localhost:3000";

const socketHeaders = (overrides?: Record<string, string>) => ({
  Upgrade: "websocket",
  Origin: ALLOWED_ORIGIN,
  ...overrides,
});

async function errorOf(response: Response): Promise<string> {
  const body = await response.json<{ error: string }>();
  return body.error;
}

describe("/healthz", () => {
  it("reports version and config readiness without touching a Durable Object", async () => {
    const response = await SELF.fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json<{
      ok: boolean;
      version: { id: string };
      ready: { roomTokenSecret: boolean; allowedOrigins: boolean };
    }>();
    expect(body.ok).toBe(true);
    expect(body.ready).toEqual({ roomTokenSecret: true, allowedOrigins: true });
    expect(typeof body.version.id).toBe("string");
    expect(await listDurableObjectIds(env.COLLABORATION_ROOM)).toHaveLength(0);
  });

  it("only answers GET", async () => {
    const response = await SELF.fetch(`${BASE}/healthz`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("unknown routes", () => {
  it.each([
    "/",
    "/v1",
    "/v1/rooms",
    "/v1/rooms/room-a/generations/1",
    "/v1/rooms/room-a/generations/1/socket/extra",
    "/v1/control/extra",
    "/metrics",
  ])("closes %s with 404", async (path) => {
    const response = await SELF.fetch(`${BASE}${path}`);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("not-found");
  });
});

describe("retired public ingress", () => {
  it.each([
    "/v1/control",
    "/v1/room-key",
    "/v1/rooms/room-a/generations/1/socket",
  ])("refuses %s without creating an old Object", async (path) => {
    const response = await SELF.fetch(`${BASE}${path}`, {
      method: path.endsWith("socket") ? "GET" : "POST",
      headers: socketHeaders(),
      body: path.endsWith("socket") ? undefined : JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    expect(await listDurableObjectIds(env.COLLABORATION_ROOM)).toHaveLength(0);
  });
});

describe("socket route", () => {
  const route = "/v1/rooms/room-a/socket";
  it.each<[string, string, RequestInit, number, string]>([
    [
      "a malformed room id",
      "/v1/rooms/a.b/socket",
      { headers: socketHeaders() },
      404,
      "not-found",
    ],
    [
      // Without the upgrade header: workerd delivers an upgrade request as GET.
      "a non-GET method",
      route,
      { method: "POST", headers: { Origin: ALLOWED_ORIGIN } },
      405,
      "method-not-allowed",
    ],
    [
      "a request without an upgrade",
      route,
      { headers: { Origin: ALLOWED_ORIGIN } },
      426,
      "upgrade-required",
    ],
    [
      "an untrusted origin",
      route,
      { headers: socketHeaders({ Origin: "https://untrusted.test" }) },
      403,
      "forbidden",
    ],
    [
      "a missing origin",
      route,
      { headers: { Upgrade: "websocket" } },
      403,
      "forbidden",
    ],
  ])(
    "refuses %s before reaching an Object",
    async (_label, path, init, status, error) => {
      const response = await SELF.fetch(`${BASE}${path}`, init);
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toBe(error);
      expect(await listDurableObjectIds(env.COLLABORATION_ROOM)).toHaveLength(
        0,
      );
    },
  );
});
