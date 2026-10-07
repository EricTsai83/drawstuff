import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canvasFixture } from "./canvas-fixture.ts";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  deriveSnapshotKey,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  openCollaborationSnapshot,
  sealCollaborationSnapshot,
} from "@drawstuff/collaboration/snapshot";
import { checksum, MAX_BINARY_BYTES, NORMAL_QUEUE_LIMIT } from "./contracts.ts";

import {
  bindings,
  fresh,
  call,
  direct,
  control,
  until,
  result,
} from "./support.ts";

describe("P0 real PostgreSQL ordering through workerd", () => {
  it("revoke waits for the accepted write's real row lock, then fences every late write", async () => {
    const operation = await fresh();
    const gate = `locked:${operation.operationId}`;
    await control("hold", gate);
    const write = call("/write", operation, new Uint8Array([1, 2, 3]));
    await until(async () => (await control("state", gate)).reached);
    const fence = call("/revoke", operation);
    const cancel = direct("/cancel", operation);
    try {
      await until(async () => (await control("state")).locks > 0);
      expect((await control("state")).sessions).toBeGreaterThanOrEqual(3);
      expect(
        (await call("/write", await fresh({ roomId: operation.roomId })))
          .status,
      ).toBe(403);
    } finally {
      await control("release", gate);
    }
    expect(await result(Promise.resolve(write))).toEqual({
      status: "written",
      revision: 1,
    });
    expect(await (await fence).json()).toEqual({ status: "enforced" });
    expect(await result(Promise.resolve(cancel))).toEqual({
      status: "written",
      revision: 1,
    });
    const late = await fresh({ roomId: operation.roomId, expectedRevision: 1 });
    expect(
      await result(direct("/write", late, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "refused", revision: null });
    const snapshot = await direct("/read", operation);
    expect(snapshot.headers.get("x-p0-revision")).toBe("1");
  });

  it("a lost commit response survives eviction and duplicate retries never overwrite newer data", async () => {
    const operation = await fresh();
    await control("drop", operation.operationId);
    expect(
      await result(call("/write", operation, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "pending", revision: null });
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await evictDurableObject(stub);
    expect(await result(call("/status", operation))).toEqual({
      status: "written",
      revision: 1,
    });
    const newer = await fresh({
      roomId: operation.roomId,
      expectedRevision: 1,
    });
    expect(
      await result(call("/write", newer, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "written", revision: 2 });
    expect(
      await result(call("/write", operation, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "written", revision: 1 });
    expect(
      (await direct("/read", operation)).headers.get("x-p0-revision"),
    ).toBe("2");
    expect(
      (
        await call(
          "/write",
          { ...operation, checksum: "0".repeat(64) },
          new Uint8Array([1, 2, 3]),
        )
      ).status,
    ).toBe(409);
  });

  it("cancellation wins against a delayed request before lock acquisition", async () => {
    const operation = await fresh();
    const gate = `before:${operation.operationId}`;
    await control("hold", gate);
    const delayed = direct("/write", operation, new Uint8Array([1, 2, 3]));
    await until(async () => (await control("state", gate)).reached);
    try {
      expect(await result(direct("/cancel", operation))).toEqual({
        status: "cancelled",
        revision: null,
      });
    } finally {
      await control("release", gate);
    }
    expect(await result(Promise.resolve(delayed))).toEqual({
      status: "cancelled",
      revision: null,
    });
  });

  it("a vanished browser leaves only metadata; eviction and alarm cancel it and reject replay after result cleanup", async () => {
    const operation = await fresh({ deadline: Date.now() - 1 });
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO operations VALUES (?,?,'pending',NULL)",
        operation.operationId,
        JSON.stringify(operation),
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("roomId", operation.roomId);
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await result(call("/status", operation))).toEqual({
      status: "cancelled",
      revision: null,
    });
    expect(
      await result(direct("/write", operation, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "cancelled", revision: null });
    await control("prune", operation.operationId);
    expect(
      await result(direct("/write", operation, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "refused", revision: null });
    const unrecorded = await fresh({ deadline: Date.now() - 1 });
    expect(
      await result(direct("/write", unrecorded, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "refused", revision: null });
  });

  it("DB failure leaves enforcement pending; a durable alarm recovers it after eviction", async () => {
    const operation = await fresh();
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await control("fault", undefined, true);
    try {
      expect(await (await call("/revoke", operation)).json()).toEqual({
        status: "pending",
      });
      await evictDurableObject(stub);
      expect((await call("/read", operation)).status).toBe(403);
    } finally {
      await control("fault", undefined, false);
    }
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await (await call("/revoke", operation)).json()).toEqual({
      status: "enforced",
    });
    expect(
      await result(direct("/write", operation, new Uint8Array([1, 2, 3]))),
    ).toEqual({ status: "refused", revision: null });
  });

  it("an ordinary queue at capacity still admits revocation and its fence", async () => {
    const operation = await fresh();
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < NORMAL_QUEUE_LIMIT; index += 1) {
        const metadata = { ...operation, operationId: crypto.randomUUID() };
        state.storage.sql.exec(
          "INSERT INTO operations VALUES (?,?,'pending',NULL)",
          metadata.operationId,
          JSON.stringify(metadata),
        );
      }
    });
    expect(
      (await call("/write", operation, new Uint8Array([1, 2, 3]))).status,
    ).toBe(429);
    expect(await (await call("/revoke", operation)).json()).toEqual({
      status: "enforced",
    });
  });

  it("the maximum sealed binary snapshot round-trips and decrypts without DO payload storage", async () => {
    const roomId = roomIdSchema.parse(`p0-${crypto.randomUUID()}`);
    const key = await deriveSnapshotKey({
      roomKey: generateRoomKey(),
      roomId,
      authGeneration: 1,
    });
    const plaintext = canvasFixture(roomId, MAX_SNAPSHOT_PLAINTEXT_BYTES);
    const sealed = await sealCollaborationSnapshot({
      key,
      plaintext,
      roomId,
      authGeneration: 1,
      revision: 1,
    });
    if (!sealed.ok) throw new Error("fixture encryption failed");
    expect(sealed.ciphertext.length).toBe(MAX_BINARY_BYTES);
    const operation = await fresh({ roomId }, sealed.ciphertext);
    expect(await result(call("/write", operation, sealed.ciphertext))).toEqual({
      status: "written",
      revision: 1,
    });
    const response = await call("/read", operation);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    expect(await checksum(ciphertext)).toBe(operation.checksum);
    const opened = await openCollaborationSnapshot({
      key,
      ciphertext,
      roomId,
      authGeneration: 1,
      revision: 1,
    });
    if (!opened.ok) throw new Error("fixture decryption failed");
    expect(await checksum(opened.plaintext)).toBe(await checksum(plaintext));
    const rows = await runInDurableObject(
      bindings.P0_ROOM.getByName(roomId),
      (_instance, state) =>
        state.storage.sql
          .exec<{ length: number }>(
            "SELECT length(metadata) AS length FROM operations",
          )
          .toArray(),
    );
    expect(rows[0]?.length).toBeLessThan(1_024);
    const oversized = new Uint8Array(MAX_BINARY_BYTES + 1);
    expect(
      (await call("/write", await fresh({ roomId }, oversized), oversized))
        .status,
    ).toBe(413);
    expect(
      (await direct("/write", await fresh({ roomId }, oversized), oversized))
        .status,
    ).toBe(413);
  });

  it("slow persistence does not hold the DO across external I/O or delay local revocation", async () => {
    const operation = await fresh();
    const socket = (await call("/socket", operation)).webSocket;
    if (!socket) throw new Error("missing-socket");
    socket.accept();
    const gate = `locked:${operation.operationId}`;
    await control("hold", gate);
    const write = call("/write", operation, new Uint8Array([1, 2, 3]));
    await until(async () => (await control("state", gate)).reached);
    const echo = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data), {
        once: true,
      }),
    );
    socket.send("presence");
    expect(await echo).toBe("presence");
    const fence = call("/revoke", operation);
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    await until(async () => (await control("state")).locks > 0);
    socket.send("after-revoke");
    try {
      expect(await closed).toBe(4003);
    } finally {
      await control("release", gate);
    }
    await write;
    expect(await (await fence).json()).toEqual({ status: "enforced" });
  });
});
