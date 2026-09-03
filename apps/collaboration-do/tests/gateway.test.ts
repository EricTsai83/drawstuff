import {
  env,
  listDurableObjectIds,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
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

import {
  INTERNAL_AUTH_GENERATION_HEADER,
  INTERNAL_ROOM_ID_HEADER,
} from "../src/internal.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./support/audit.ts";
import {
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
} from "./support/room-socket.ts";

afterEach(settleRoomEvents);

const BASE = "https://collaboration-gateway.test";
const ALLOWED_ORIGIN = "http://localhost:3000";
const SOCKET_PATH = "/v1/rooms/room-a/generations/1/socket";

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

function postControl(body: BodyInit, contentType = "application/json") {
  return SELF.fetch(`${BASE}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
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

describe("socket route", () => {
  it("forwards a valid upgrade to the room object, which accepts the socket", async () => {
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      headers: socketHeaders(),
    });
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it.each([
    ["non-canonical generation 0", "/v1/rooms/room-a/generations/0/socket"],
    ["leading-zero generation", "/v1/rooms/room-a/generations/01/socket"],
    ["non-numeric generation", "/v1/rooms/room-a/generations/abc/socket"],
    ["oversized generation", "/v1/rooms/room-a/generations/12345678901/socket"],
    ["negative generation", "/v1/rooms/room-a/generations/-1/socket"],
    ["oversized room id", `/v1/rooms/${"a".repeat(65)}/generations/1/socket`],
    ["percent-encoded room id", "/v1/rooms/room%2Fa/generations/1/socket"],
  ])("closes a malformed identity (%s) with 404", async (_label, path) => {
    const response = await SELF.fetch(`${BASE}${path}`, {
      headers: socketHeaders(),
    });
    expect(response.status).toBe(404);
  });

  it("rejects non-GET methods", async () => {
    // No Upgrade header here: workerd turns any fetch carrying one into a
    // GET upgrade request, so a "POST upgrade" cannot exist on the wire.
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(405);
  });

  it("requires a WebSocket upgrade", async () => {
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(426);
  });

  it("rejects a missing Origin", async () => {
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a disallowed Origin", async () => {
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      headers: socketHeaders({ Origin: "https://evil.example" }),
    });
    expect(response.status).toBe(403);
  });

  it("strips spoofed internal identity headers before forwarding", async () => {
    // If the spoofed headers survived, the object named room-a-g1 would see
    // room-b's identity and answer 403 identity-mismatch instead of
    // accepting the upgrade.
    const response = await SELF.fetch(`${BASE}${SOCKET_PATH}`, {
      headers: socketHeaders({
        [INTERNAL_ROOM_ID_HEADER]: "room-b",
        [INTERNAL_AUTH_GENERATION_HEADER]: "2",
      }),
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});

describe("control route", () => {
  it("dispatches a verified control token to the room object as typed RPC", async () => {
    const response = await postControl(
      JSON.stringify({ token: endRoomToken() }),
    );
    expect(response.status).toBe(200);
    // The full contract matrix lives in room-control.test.ts; here the
    // gateway proves the response is the RPC result and nothing else.
    expect(await response.json()).toEqual({ appliedRevision: 1, closed: 0 });
  });

  it("only answers POST", async () => {
    const response = await SELF.fetch(`${BASE}/v1/control`);
    expect(response.status).toBe(405);
  });

  it("requires a JSON content type", async () => {
    const response = await postControl("token=x", "text/plain");
    expect(response.status).toBe(415);
  });

  it("bounds the body before parsing", async () => {
    const oversized = JSON.stringify({ token: "x".repeat(4_000) });
    const response = await postControl(oversized);
    expect(response.status).toBe(413);
  });

  it("closes malformed JSON", async () => {
    const response = await postControl("{not json");
    expect(response.status).toBe(400);
  });

  it.each([
    ["empty token", { token: "" }],
    ["missing token", {}],
    ["unknown keys", { token: "x", extra: true }],
  ])("closes a malformed envelope (%s)", async (_label, payload) => {
    const response = await postControl(JSON.stringify(payload));
    expect(response.status).toBe(400);
  });

  it("rejects a token signed with another secret", async () => {
    const forged = endRoomToken({
      secret: "another-secret-that-is-long-enough-0000000000000",
    });
    const response = await postControl(JSON.stringify({ token: forged }));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe("unauthorized");
  });

  it("rejects an expired token", async () => {
    const response = await postControl(
      JSON.stringify({ token: endRoomToken({ expired: true }) }),
    );
    expect(response.status).toBe(401);
  });

  it("answers a deterministic Object-side refusal non-retryably, naming the code", async () => {
    const roomId = uniqueRoomId("ctlskew");
    // Storage from a newer build: this build refuses it on every call, so a
    // retry could only repeat the refusal — the web outbox must see a 4xx,
    // not the retryable 503 reserved for genuine unavailability.
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_meta SET schema_version = 99 WHERE id = 1",
      );
    });
    const response = await postControl(
      JSON.stringify({ token: endRoomToken({ roomId }) }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "control-rejected",
      code: "schema-skew",
    });
  });
});
