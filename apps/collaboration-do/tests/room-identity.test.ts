import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { roomChannelKey } from "@drawstuff/collaboration/room-auth";

import {
  INTERNAL_AUTH_GENERATION_HEADER,
  INTERNAL_ROOM_ID_HEADER,
} from "../src/internal.ts";

const ROOM_A = roomIdSchema.parse("room-a");
const ROOM_B = roomIdSchema.parse("room-b");

const identityHeaders = (roomId: string, generation: string) => ({
  [INTERNAL_ROOM_ID_HEADER]: roomId,
  [INTERNAL_AUTH_GENERATION_HEADER]: generation,
});

describe("RoomChannelKey object identity", () => {
  it("maps one channel key to one deterministic object id", () => {
    const key = roomChannelKey(ROOM_A, 1);
    const first = env.COLLABORATION_ROOM.getByName(key);
    const second = env.COLLABORATION_ROOM.getByName(key);
    expect(first.id.toString()).toBe(second.id.toString());
  });

  it("gives a rotated generation a different object", () => {
    const generationOne = env.COLLABORATION_ROOM.getByName(
      roomChannelKey(ROOM_A, 1),
    );
    const generationTwo = env.COLLABORATION_ROOM.getByName(
      roomChannelKey(ROOM_A, 2),
    );
    expect(generationOne.id.toString()).not.toBe(generationTwo.id.toString());
  });

  it("gives different rooms different objects", () => {
    const roomA = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_A, 1));
    const roomB = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_B, 1));
    expect(roomA.id.toString()).not.toBe(roomB.id.toString());
  });
});

describe("CollaborationRoom fetch identity check", () => {
  it("accepts a matching identity but still requires a WebSocket upgrade", async () => {
    const stub = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_A, 1));
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_A, "1"),
    });
    // Identity passed; the runtime's own defense-in-depth upgrade check is
    // what refuses a plain fetch.
    expect(response.status).toBe(426);
  });

  it("fails closed on a mismatched forwarded identity", async () => {
    const stub = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_A, 1));
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_B, "1"),
    });
    expect(response.status).toBe(403);
  });

  it("fails closed on a mismatched generation", async () => {
    const stub = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_A, 1));
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_A, "2"),
    });
    expect(response.status).toBe(403);
  });

  it("fails closed without internal identity metadata", async () => {
    const stub = env.COLLABORATION_ROOM.getByName(roomChannelKey(ROOM_A, 1));
    const response = await stub.fetch("https://room.internal/socket");
    expect(response.status).toBe(403);
  });

  it("fails closed on an unnamed (newUniqueId) object", async () => {
    const stub = env.COLLABORATION_ROOM.get(
      env.COLLABORATION_ROOM.newUniqueId(),
    );
    const response = await stub.fetch("https://room.internal/socket", {
      headers: identityHeaders(ROOM_A, "1"),
    });
    expect(response.status).toBe(500);
  });
});

describe("CollaborationRoom RPC identity", () => {
  it("applies a control RPC only when the command derives its own name", async () => {
    const key = roomChannelKey(ROOM_A, 7);
    const stub = env.COLLABORATION_ROOM.getByName(key);
    await expect(
      stub.applyControlV1({
        v: 1,
        action: "end-room",
        roomId: ROOM_A,
        authGeneration: 7,
        revision: 2,
      }),
    ).resolves.toEqual({ appliedRevision: 2, closed: 0 });
  });

  it("rejects RPC on an unnamed object", async () => {
    const stub = env.COLLABORATION_ROOM.get(
      env.COLLABORATION_ROOM.newUniqueId(),
    );
    // Invoked inside the object's own context: calling over the RPC stub
    // would pass, but workerd then also reports the object-side throw as an
    // unhandled error and fails the run.
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.applyControlV1({
          v: 1,
          action: "end-room",
          roomId: ROOM_A,
          authGeneration: 1,
          revision: 2,
        }),
      ).rejects.toThrow("canonical RoomChannelKey");
    });
  });
});

describe("CollaborationRoom alarm identity", () => {
  it("runs the scheduler on a named object without error", async () => {
    const key = roomChannelKey(ROOM_A, 3);
    const stub = env.COLLABORATION_ROOM.getByName(key);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 50);
    });
    // No sockets, no cohort, no cutoffs: the scheduler treats the room as
    // never joined and releases its storage entirely.
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room_meta', 'revocation_cutoffs')",
        )
        .toArray(),
    );
    expect(tables).toHaveLength(0);
  });
});
