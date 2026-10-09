import {
  env,
  SELF,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterCommandSchema,
  lifecycleObjectName,
  type LifecycleCommand,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { RoomAuthority } from "../src/room-authority.ts";
import { storageFootprint, userTables } from "./support/room-socket.ts";
const service = "test-authority-secret-purpose-only-0001";
afterEach(() => vi.restoreAllMocks());
describe("private Lifecycle entry and real Room retirement RPC", () => {
  it("requires the service capability, persists begin after a lost caller, resumes after eviction, and withholds deletion until the Room storage fence succeeds", async () => {
    const subject = `retire-${crypto.randomUUID()}`,
      roomId = roomIdSchema.parse(`retire-${crypto.randomUUID()}`);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: subject,
      target: { kind: "account", subject },
    };
    const lifecycle = env.COLLABORATION_LIFECYCLE.getByName(
      lifecycleObjectName(command.target),
    );
    const room = env.COLLABORATION_ROOM.getByName(roomId);
    let allowFence = false,
      deleted = 0,
      freezeCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      // Build the actual runtime Request; mock transport still exercises redirect compatibility.
      const request = new Request(input, init);
      const inputCommand = adapterCommandSchema.parse(await request.json());
      if (inputCommand.action === "lifecycle-freeze") {
        freezeCalls++;
        return Response.json({ version: 2 });
      }
      if (inputCommand.action === "lifecycle-list")
        return Response.json({
          version: 2,
          rooms: [{ roomId, action: "end-room" }],
          cursor: null,
        });
      if (inputCommand.action === "lifecycle-delete") {
        deleted++;
        return Response.json({ deleted: true });
      }
      if (inputCommand.action === "fence")
        return allowFence
          ? Response.json({ authorityEpoch: inputCommand.authorityEpoch })
          : new Response(null, { status: 503 });
      if (inputCommand.action === "cleanup")
        return Response.json({ cleaned: true });
      if (inputCommand.action === "project")
        return Response.json({ applied: true });
      throw new Error("unexpected-adapter-command");
    });
    const configure = async () => {
      for (const stub of [room, lifecycle])
        await runInDurableObject(stub, (instance) => {
          const bindings: unknown = Reflect.get(instance, "env");
          if (bindings && typeof bindings === "object")
            Object.assign(bindings, {
              COLLAB_ADAPTER_URL:
                "https://adapter.test/api/internal/collaboration/adapter",
              COLLAB_ADAPTER_SECRET: service,
            });
        });
    };
    await configure();
    await runInDurableObject(room, async (_instance, state) => {
      const authority = new RoomAuthority(state.storage, roomId);
      const create = {
        v: 1 as const,
        action: "create" as const,
        roomId,
        operationId: crypto.randomUUID(),
        deadline: Date.now() + 55_000,
        actor: { subject, email: "owner@example.com", lifecycleVersion: 1 },
        sceneId: null,
        label: "Retire",
        linkRole: "none" as const,
      };
      await authority.apply(create);
      await authority.confirmParent(create.operationId);
      state.storage.sql.exec("DELETE FROM authority_work");
      state.storage.sql.exec("UPDATE authority_room SET state='ready'");
    });
    const post = (authorization: string) =>
      SELF.fetch("https://worker.test/v1/lifecycle", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "begin", command }),
      });
    expect(
      (await post("identity-proof-is-not-a-service-capability")).status,
    ).toBe(401);
    expect((await post(service)).status).toBe(200);
    await evictDurableObject(lifecycle);
    await configure();
    const advance = () =>
      runInDurableObject(lifecycle, async (instance, state) => {
        state.storage.sql.exec("UPDATE authority_work SET next_at=0");
        await instance.alarm();
      });
    await advance();
    await advance();
    await advance();
    expect((await lifecycle.query(command.operationId))?.phase).toBe(
      "enforcing",
    );
    expect(deleted).toBe(0);
    const epoch = await runInDurableObject(room, (_instance, state) => {
      const authority = new RoomAuthority(state.storage, roomId);
      expect(authority.state()?.state).toBe("ended");
      return authority.state()!.authority_epoch;
    });
    await evictDurableObject(room);
    await configure();
    allowFence = true;
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec("UPDATE authority_work SET next_at=0");
    });
    await advance();
    await advance();
    await advance();
    expect((await lifecycle.query(command.operationId))?.phase).toBe(
      "completed",
    );
    expect(deleted).toBe(1);
    expect(freezeCalls).toBe(1);
    expect(
      await room.enforceRetirementV1({
        command,
        version: 2,
        room: { roomId, action: "end-room" },
      }),
    ).toBe("enforced");
    // A settled ended room may already have released its storage; if it is
    // still there, the repeated enforcement must not have fenced again.
    const after = await runInDurableObject(room, (_instance, state) =>
      userTables(state).includes("authority_room")
        ? new RoomAuthority(state.storage, roomId).state()?.authority_epoch
        : undefined,
    );
    if (after !== undefined) expect(after).toBe(epoch);
    expect((await post(service)).status).toBe(200);
    expect(deleted).toBe(1);
  });
  it("enforces retirement for a room that was never created without leaving storage behind", async () => {
    const subject = `missing-${crypto.randomUUID()}`,
      roomId = roomIdSchema.parse(`missing-${crypto.randomUUID()}`);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: subject,
      target: { kind: "account", subject },
    };
    // The web side refuses a delayed creation for a retired account; the
    // Object keeps nothing for a room that does not exist.
    expect(
      await env.COLLABORATION_ROOM.getByName(roomId).enforceRetirementV1({
        command,
        version: 2,
        room: { roomId, action: "end-room" },
      }),
    ).toBe("enforced");
    expect(await storageFootprint(roomId)).toEqual({ tables: [], alarm: null });
  });
});
