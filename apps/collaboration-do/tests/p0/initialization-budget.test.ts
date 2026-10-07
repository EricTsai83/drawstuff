import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkBudget } from "./work-budget.ts";
import {
  ALARM_BATCH_LIMIT,
  MANAGEMENT_RESULT_LIMIT,
  NORMAL_QUEUE_LIMIT,
  SECURITY_QUEUE_LIMIT,
} from "./contracts.ts";
import {
  bindings,
  call,
  control,
  direct,
  fresh,
  result,
  until,
} from "./support.ts";

const bytes = new Uint8Array([1, 2, 3]);
const keyHeaders = { "x-p0-key-check": "a".repeat(64) };
const alarmNow = async (roomId: string) => {
  const stub = bindings.P0_ROOM.getByName(roomId);
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("UPDATE work SET next_at=0"),
  );
  await runDurableObjectAlarm(stub);
};

describe("P0 initialization, attachments and bounded recovery", () => {
  it("constructs and evicts 700 rooms without accumulating the test plugin's prototype proxies", async () => {
    const seed = await fresh();
    for (let index = 0; index < 700; index++) {
      const operation = { ...seed, roomId: `p0-${crypto.randomUUID()}` };
      expect((await call("/ping", operation)).status).toBe(204);
      await evictDurableObject(bindings.P0_ROOM.getByName(operation.roomId));
    }
  }, 60_000);
  it("commits intent, pending work and its alarm together, and rolls all three back on error", async () => {
    const operation = await fresh();
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await runInDurableObject(stub, async (_instance, state) => {
      const work = new WorkBudget(state.storage);
      await expect(
        work.commit(() => {
          state.storage.sql.exec("UPDATE authority SET writer_revoked=1");
          work.add("fence");
          throw new Error("injected rollback");
        }),
      ).rejects.toThrow("injected rollback");
      expect(
        state.storage.sql
          .exec<{ writer_revoked: number }>(
            "SELECT writer_revoked FROM authority",
          )
          .one().writer_revoked,
      ).toBe(0);
      expect(
        state.storage.sql.exec("SELECT * FROM work").toArray(),
      ).toHaveLength(0);
      expect(await state.storage.getAlarm()).toBeNull();
      await work.commit(() => {
        state.storage.sql.exec("UPDATE authority SET writer_revoked=1");
        work.add("fence");
      });
      expect(
        state.storage.sql.exec("SELECT * FROM work").toArray(),
      ).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
  it("blocks join until the declared ciphertext and every attachment are durable, then survives eviction", async () => {
    const asset = await fresh({ actor: "owner" });
    const create = await fresh({
      actor: "owner",
      roomId: asset.roomId,
      assetIds: [asset.operationId],
    });
    expect((await call("/create", create, undefined, keyHeaders)).status).toBe(
      200,
    );
    const snapshot = await fresh({
      ...create,
      operationId: crypto.randomUUID(),
    });
    const writer = { ...snapshot, actor: "writer" as const };
    expect((await call("/join", writer)).status).toBe(409);
    expect((await call("/write", writer, bytes)).status).toBe(409);
    expect(await result(direct("/asset-upload", asset, bytes))).toEqual({
      status: "written",
      revision: null,
    });
    expect(await result(call("/write", snapshot, bytes))).toEqual({
      status: "pending",
      revision: null,
    });
    expect(
      (await call("/initialize-finish", snapshot, undefined, keyHeaders))
        .status,
    ).toBe(202);
    expect(await result(call("/asset-finalize", asset))).toEqual({
      status: "written",
      revision: null,
    });
    expect(await result(call("/write", snapshot, bytes))).toEqual({
      status: "written",
      revision: 1,
    });
    expect(
      await (
        await call("/initialize-finish", snapshot, undefined, keyHeaders)
      ).json(),
    ).toEqual({ status: "ready" });
    await evictDurableObject(bindings.P0_ROOM.getByName(create.roomId));
    expect(
      new Uint8Array(await (await call("/join", writer)).arrayBuffer()),
    ).toEqual(bytes);
    expect(
      (
        await call(
          "/create",
          { ...create, checksum: "b".repeat(64) },
          undefined,
          keyHeaders,
        )
      ).status,
    ).toBe(409);
  });

  it("initialization expiry is durable, cleans only its room, and refuses a late upload or finish", async () => {
    const asset = await fresh({ actor: "owner" });
    const create = await fresh({
      actor: "owner",
      roomId: asset.roomId,
      assetIds: [asset.operationId],
    });
    await call("/create", create, undefined, keyHeaders);
    await direct("/asset-upload", asset, bytes);
    const other = await fresh({ actor: "owner" });
    await direct("/asset-upload", other, bytes);
    await call("/asset-finalize", other);
    const stub = bindings.P0_ROOM.getByName(create.roomId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE initialization SET deadline=0");
      state.storage.sql.exec("UPDATE work SET next_at=0");
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    expect((await call("/asset-finalize", asset)).status).toBe(403);
    expect(
      (await call("/initialize-finish", create, undefined, keyHeaders)).status,
    ).toBe(403);
    await alarmNow(create.roomId);
    expect(await result(direct("/asset-upload", asset, bytes))).toEqual({
      status: "refused",
      revision: null,
    });
    expect(await (await direct("/asset-index", asset)).json()).toEqual({
      assetIds: [],
    });
    expect(await (await direct("/asset-index", other)).json()).toEqual({
      assetIds: [other.operationId],
    });
  });

  it("cancelling initialization during provider transfer cannot be undone by its late callback", async () => {
    const asset = await fresh({ actor: "owner" });
    const create = await fresh({
      actor: "owner",
      roomId: asset.roomId,
      assetIds: [asset.operationId],
    });
    await call("/create", create, undefined, keyHeaders);
    const gate = `upload:${asset.operationId}`;
    await control("hold", gate);
    const upload = direct("/asset-upload", asset, bytes);
    await until(async () => (await control("state", gate)).reached);
    try {
      expect(await (await call("/initialize-cancel", create)).json()).toEqual({
        status: "enforced",
      });
    } finally {
      await control("release", gate);
    }
    expect(await result(Promise.resolve(upload))).toEqual({
      status: "refused",
      revision: null,
    });
    expect((await call("/asset-finalize", asset)).status).toBe(403);
    await alarmNow(create.roomId);
    expect(await (await direct("/asset-index", asset)).json()).toEqual({
      assetIds: [],
    });
  });

  it("coalesces repeated subject safety work and stops the room durably when its reserve is exhausted", async () => {
    const operation = await fresh();
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await control("fault", undefined, true);
    try {
      for (let i = 0; i < 3; i++)
        expect(
          (
            await call("/revoke", {
              ...operation,
              operationId: crypto.randomUUID(),
            })
          ).status,
        ).toBe(202);
      expect(
        await runInDurableObject(
          stub,
          (_instance, state) =>
            state.storage.sql
              .exec<{ count: number }>("SELECT count(*) AS count FROM security")
              .one().count,
        ),
      ).toBe(1);
      await runInDurableObject(stub, (_instance, state) => {
        for (let i = 1; i < SECURITY_QUEUE_LIMIT; i++)
          state.storage.sql.exec(
            "INSERT INTO security VALUES (?,1)",
            `subject-${i}`,
          );
      });
      const overflow = {
        ...operation,
        operationId: crypto.randomUUID(),
        subject: "overflow",
      };
      expect((await call("/revoke", overflow)).status).toBe(202);
      await evictDurableObject(stub);
      expect(
        (await call("/socket", { ...operation, actor: "owner" })).status,
      ).toBe(403);
      expect(
        await runInDurableObject(
          stub,
          (_instance, state) =>
            state.storage.sql
              .exec<{ count: number }>("SELECT count(*) AS count FROM security")
              .one().count,
        ),
      ).toBe(SECURITY_QUEUE_LIMIT);
    } finally {
      await control("fault", undefined, false);
    }
    await alarmNow(operation.roomId);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM management WHERE status='pending'",
            )
            .one().count,
      ),
    ).toBe(0);
  });

  it("retains management results at capacity and makes space only for expired terminal results", async () => {
    const operation = await fresh();
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    const expired = crypto.randomUUID();
    await runInDurableObject(stub, (_instance, state) => {
      for (let i = 0; i < MANAGEMENT_RESULT_LIMIT; i++)
        state.storage.sql.exec(
          "INSERT INTO management VALUES (?, ?,1,'enforced')",
          i === 0 ? expired : crypto.randomUUID(),
          "fixture",
        );
    });
    expect((await call("/revoke", operation)).status).toBe(429);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("INSERT INTO terminal VALUES (?,0)", expired),
    );
    expect(await (await call("/revoke", operation)).json()).toEqual({
      status: "enforced",
    });
    expect(
      (await call("/revoke", { ...operation, subject: "changed" })).status,
    ).toBe(409);
  });

  it("prioritizes the storage fence and cancels only a bounded batch without losing the rest", async () => {
    const operation = await fresh({ deadline: Date.now() - 1 });
    const stub = bindings.P0_ROOM.getByName(operation.roomId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("roomId", operation.roomId);
      state.storage.sql.exec(
        "UPDATE authority SET epoch=2,writer_revoked=1,fence_pending=1",
      );
      for (let i = 0; i < NORMAL_QUEUE_LIMIT; i++) {
        const pending = { ...operation, operationId: crypto.randomUUID() };
        state.storage.sql.exec(
          "INSERT INTO operations VALUES (?,?,'pending',NULL)",
          pending.operationId,
          JSON.stringify(pending),
        );
      }
      await state.storage.setAlarm(Date.now() + 1000);
    });
    await runDurableObjectAlarm(stub);
    const state = await runInDurableObject(stub, (_instance, state) => ({
      fence: state.storage.sql
        .exec<{ fence_pending: number }>("SELECT fence_pending FROM authority")
        .one().fence_pending,
      pending: state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM operations WHERE status='pending'",
        )
        .one().count,
    }));
    expect(state.fence).toBe(0);
    expect(state.pending).toBe(NORMAL_QUEUE_LIMIT - (ALARM_BATCH_LIMIT - 1));
  });

  it("two blocked body transfers refuse a third but allow local revocation and cancellation", async () => {
    const first = await fresh();
    const second = await fresh({ roomId: first.roomId });
    const gates = [
      `before:${first.operationId}`,
      `before:${second.operationId}`,
    ];
    for (const gate of gates) await control("hold", gate);
    const writes = [
      call("/write", first, bytes),
      call("/write", second, bytes),
    ];
    try {
      for (const gate of gates)
        await until(async () => (await control("state", gate)).reached);
      expect((await call("/read", first)).status).toBe(429);
      expect(await result(call("/cancel", first))).toEqual({
        status: "cancelled",
        revision: null,
      });
      expect(await (await call("/revoke", first)).json()).toEqual({
        status: "enforced",
      });
    } finally {
      for (const gate of gates) await control("release", gate);
    }
    const settled = await Promise.all(
      writes.map((write) => result(Promise.resolve(write))),
    );
    expect(settled.map((entry) => entry.status)).toEqual([
      "cancelled",
      "refused",
    ]);
  });

  it("does not postpone an earlier deadline and persists backoff through eviction", async () => {
    const first = await fresh({ deadline: Date.now() + 20_000 });
    const second = await fresh({ roomId: first.roomId });
    const stub = bindings.P0_ROOM.getByName(first.roomId);
    await control("fault", undefined, true);
    try {
      await call("/write", first, bytes);
      const early = await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm(),
      );
      await call("/write", second, bytes);
      expect(
        await runInDurableObject(stub, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(early);
      await alarmNow(first.roomId);
      await evictDurableObject(stub);
      const retry = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ attempts: number; next_at: number }>(
            "SELECT attempts,next_at FROM work WHERE id=?",
            first.operationId,
          )
          .one(),
      );
      expect(retry.attempts).toBe(1);
      expect(retry.next_at).toBeGreaterThan(Date.now());
    } finally {
      await control("fault", undefined, false);
    }
  });
});
