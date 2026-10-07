import { env, listDurableObjectIds, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";
import {
  ROOM_TOKEN_AUDIENCES,
  type RoomControlClaims,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signRoomControlToken,
} from "@drawstuff/collaboration/room-token";

import { TEST_ROOM_TOKEN_SECRET } from "./support/audit.ts";
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

function endRoomToken(options?: {
  roomId?: RoomId;
  secret?: string;
  expired?: boolean;
}): string {
  const now =
    Math.floor(Date.now() / 1000) - (options?.expired === true ? 3_600 : 0);
  const claims: RoomControlClaims = {
    v: 1,
    jti: createRoomTokenId(),
    iat: now,
    exp: now + 30,
    aud: ROOM_TOKEN_AUDIENCES.control,
    rid: options?.roomId ?? roomIdSchema.parse("room-a"),
    gen: 1,
    arev: 1,
    action: "end-room",
  };
  return signRoomControlToken(
    claims,
    options?.secret ?? TEST_ROOM_TOKEN_SECRET,
  );
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
  it.each(["/v1/control", "/v1/rooms/room-a/generations/1/socket"])(
    "refuses %s without creating an old Object",
    async (path) => {
      const response = await SELF.fetch(`${BASE}${path}`, {
        method: path.endsWith("control") ? "POST" : "GET",
        headers: socketHeaders(),
        body: path.endsWith("control")
          ? JSON.stringify({ token: endRoomToken() })
          : undefined,
      });
      expect(response.status).toBe(404);
      expect(await listDurableObjectIds(env.COLLABORATION_ROOM)).toHaveLength(
        0,
      );
    },
  );
});
