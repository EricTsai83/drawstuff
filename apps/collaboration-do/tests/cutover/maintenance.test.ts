import {
  env,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

const namespaces = [env.COLLABORATION_ROOM, env.COLLABORATION_LIFECYCLE];

describe("cutover maintenance runtime", () => {
  it("rejects public, private, socket and cron drain entry paths", async () => {
    for (const path of [
      "/health",
      "/v1/control",
      "/v1/authority",
      "/v1/rooms/old/g/1/socket",
      "/api/internal/collaboration/drain",
    ]) {
      const response = await SELF.fetch(`https://fixture.test${path}`, {
        method: "POST",
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("requires the capability, bounds input and acknowledges quiesced instances", async () => {
    const request = (body: string, authorized = true) =>
      SELF.fetch("https://fixture.test/internal/cutover/quiesce", {
        method: "POST",
        body,
        headers: authorized
          ? { authorization: "Bearer test-authority-secret-purpose-only-0001" }
          : {},
      });
    expect((await request("{}", false)).status).toBe(401);
    expect((await request("invalid")).status).toBe(400);
    expect((await request("x".repeat(8193))).status).toBe(413);
    expect(
      (
        await request(
          JSON.stringify({
            namespace: "room",
            objects: Array.from({ length: 17 }, () => ({ name: "old-g1" })),
          }),
        )
      ).status,
    ).toBe(400);
    for (const [index, namespace] of namespaces.entries()) {
      const stub = namespace.getByName(`quiesce-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("preserved", "keep");
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await evictDurableObject(stub);
      const response = await request(
        JSON.stringify({
          namespace: index === 0 ? "room" : "lifecycle",
          objects: [{ id: stub.id.toString() }],
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ quiesced: 1 });
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
        expect(await state.storage.get("preserved")).toBe("keep");
      });
    }
  });

  for (const [index, namespace] of namespaces.entries()) {
    it(`cancels stored alarms after eviction and retains namespace ${index} data`, async () => {
      const stub = namespace.getByName(`cutover-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("rollback-evidence", "keep");
        state.storage.sql.exec("CREATE TABLE preserved (value TEXT)");
        state.storage.sql.exec("INSERT INTO preserved VALUES ('keep')");
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await evictDurableObject(stub);
      expect((await stub.fetch("https://internal.test/private")).status).toBe(
        503,
      );
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
        expect(await state.storage.get("rollback-evidence")).toBe("keep");
        expect(
          state.storage.sql.exec("SELECT value FROM preserved").one(),
        ).toEqual({ value: "keep" });
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      });
    });
  }

  it("closes hibernated sockets on reactivation", async () => {
    const stub = env.COLLABORATION_ROOM.getByName(
      `sockets-${crypto.randomUUID()}`,
    );
    const response = await stub.fetch("https://internal.test/seed", {
      headers: { Upgrade: "websocket" },
    });
    const client = response.webSocket!;
    client.accept();
    const closed = new Promise<number>((resolve) =>
      client.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    await evictDurableObject(stub);
    const quiesced = await SELF.fetch(
      "https://fixture.test/internal/cutover/quiesce",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-authority-secret-purpose-only-0001",
        },
        body: JSON.stringify({
          namespace: "room",
          objects: [{ name: stub.id.name }],
        }),
      },
    );
    expect(quiesced.status).toBe(200);
    expect(await closed).toBe(1012);
  });
});
