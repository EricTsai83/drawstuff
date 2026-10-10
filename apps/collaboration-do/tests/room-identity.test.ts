import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";

import { INTERNAL_ROOM_ID_HEADER } from "../src/internal.ts";
import {
  envelope,
  identityProof,
  installAdapterMock,
  newIdentity,
  openRoom,
  readyRoom,
  roomStub,
  storageFootprint,
  uniqueRoomId,
} from "./support/room-socket.ts";

const ROOM_A = roomIdSchema.parse("room-a");
const ROOM_B = roomIdSchema.parse("room-b");

const identityHeaders = (roomId: string) => ({
  [INTERNAL_ROOM_ID_HEADER]: roomId,
  Upgrade: "websocket",
});

beforeEach(() => {
  installAdapterMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("roomId object identity", () => {
  it("maps one roomId to one deterministic object id", () => {
    const first = env.COLLABORATION_ROOM.getByName(ROOM_A);
    const second = env.COLLABORATION_ROOM.getByName(ROOM_A);
    expect(first.id.toString()).toBe(second.id.toString());
  });

  it("gives different rooms different objects", () => {
    const roomA = env.COLLABORATION_ROOM.getByName(ROOM_A);
    const roomB = env.COLLABORATION_ROOM.getByName(ROOM_B);
    expect(roomA.id.toString()).not.toBe(roomB.id.toString());
  });
});

describe("CollaborationRoomV2 fetch identity check", () => {
  it("accepts a matching identity but still requires a WebSocket upgrade", async () => {
    const response = await roomStub(ROOM_A).fetch(
      "https://room.internal/socket",
      { headers: { [INTERNAL_ROOM_ID_HEADER]: ROOM_A } },
    );
    // Identity passed; the runtime's own defense-in-depth upgrade check is
    // what refuses a plain fetch.
    expect(response.status).toBe(426);
  });

  it("accepts a matching upgrade only once the room is ready", async () => {
    const roomId = uniqueRoomId("identity");
    const stub = roomStub(roomId);
    const before = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(roomId),
    });
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({
      error: "authority-socket-unavailable",
    });
    await readyRoom(roomId, newIdentity("owner"));
    const after = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(roomId),
    });
    expect(after.status).toBe(101);
    after.webSocket?.accept();
    after.webSocket?.close(1000, "test finished");
  });

  it("fails closed on a mismatched forwarded identity", async () => {
    const { roomId } = await openRoom("mismatch");
    const response = await roomStub(roomId).fetch(
      "https://room.internal/socket",
      { headers: identityHeaders(uniqueRoomId("other")) },
    );
    expect(response.status).toBe(403);
  });

  it("fails closed without internal identity metadata", async () => {
    const response = await roomStub(ROOM_A).fetch(
      "https://room.internal/socket",
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(403);
  });

  it("fails closed on an unnamed (newUniqueId) object", async () => {
    const stub = env.COLLABORATION_ROOM.get(
      env.COLLABORATION_ROOM.newUniqueId(),
    );
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_A),
    });
    expect(response.status).toBe(500);
  });

  it("fails closed on an object named with something other than a roomId", async () => {
    const stub = env.COLLABORATION_ROOM.getByName("not a room id!");
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_A),
    });
    expect(response.status).toBe(500);
  });
});

describe("CollaborationRoomV2 RPC identity", () => {
  it("answers authority RPC only for requests naming its own room", async () => {
    const { roomId, owner } = await openRoom("rpc");
    const other = uniqueRoomId("rpc-other");
    await expect(
      roomStub(roomId).applyAuthorityV1({
        proof: identityProof(other, owner),
        request: { ...envelope(other), action: "get-state" },
      }),
    ).resolves.toEqual({ ok: false, error: "not-found" });
  });

  it("rejects RPC on an unnamed object", async () => {
    const stub = env.COLLABORATION_ROOM.get(
      env.COLLABORATION_ROOM.newUniqueId(),
    );
    // Invoked inside the object's own context: calling over the RPC stub
    // would pass, but workerd then also reports the object-side throw as an
    // unhandled error and fails the run.
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.applyAuthorityV1({})).rejects.toThrow(
        "canonical roomId",
      );
    });
  });
});

describe("CollaborationRoomV2 alarm identity", () => {
  it("runs the scheduler on a named object and releases a roomless Object's storage", async () => {
    const roomId = uniqueRoomId("alarm");
    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (_instance, state) => {
      // The helper forces execution; a short wall-clock deadline can fire first under suite load.
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    expect(await storageFootprint(roomId)).toEqual({ tables: [], alarm: null });
  });
});
