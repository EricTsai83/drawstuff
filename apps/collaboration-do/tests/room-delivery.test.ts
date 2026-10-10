import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PerformanceTimings } from "@drawstuff/collaboration/performance";
import {
  adapterCommandSchema,
  AUTHORITY_LIMITS,
  type AdapterCommand,
  type ContentOperation,
  type DurableJob,
  type RoomCommand,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { AdapterClient } from "../src/adapter-client.ts";
import { RoomAuthority } from "../src/room-authority.ts";
import { RoomDelivery } from "../src/room-delivery.ts";
import { CollaborationRoomV2 } from "../src/room.ts";

const config = {
  COLLAB_ADAPTER_URL: "https://web.example/api/internal/collaboration/adapter",
  COLLAB_ADAPTER_SECRET: "test-adapter-secret-purpose-only-0001",
};
const actor: TrustedIdentity = {
  subject: "owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const signal = () => new AbortController().signal;
function fixture() {
  const roomId = roomIdSchema.parse(`delivery-${crypto.randomUUID()}`);
  const stub = env.COLLABORATION_ROOM.getByName(roomId);
  const command = (action: RoomCommand["action"]) => ({
    v: 1 as const,
    operationId: crypto.randomUUID(),
    roomId,
    actor,
    deadline: Date.now() + 50_000,
    action,
  });
  return { roomId, stub, command };
}
function client(
  handler: (command: AdapterCommand) => Promise<Response> | Response,
) {
  return new AdapterClient(config, async (_input, init) => {
    if (typeof init?.body !== "string")
      throw new Error("expected-json-command");
    return handler(
      adapterCommandSchema.parse(JSON.parse(init.body) as unknown),
    );
  });
}
const manifest = { revision: 1, checksum: "a".repeat(64), assetIds: [] };
async function initialize(
  a: RoomAuthority,
  command: ReturnType<typeof fixture>["command"],
) {
  await a.apply({
    ...command("create"),
    action: "create",
    sceneId: null,
    label: "",
    linkRole: "editor",
  });
  await a.confirmParent(a.state()!.create_operation);
  const complete = {
    ...command("complete-initialization"),
    action: "complete-initialization" as const,
    manifest,
  };
  await a.apply(complete);
  return complete;
}

describe("metadata adapter transport", () => {
  it("collects opt-in I/O and storage timings without accepting unknown header fields", async () => {
    const timings: PerformanceTimings = {};
    const c = new AdapterClient(
      config,
      async (_url, init) => {
        expect(
          new Headers(init?.headers).get("x-collab-performance-probe"),
        ).toBe("1");
        return Response.json(
          { assets: [] },
          { headers: { "server-timing": "storage;dur=2.5, secret;dur=9" } },
        );
      },
      timings,
    );
    const result = await c.call(
      {
        v: 1,
        action: "read-assets",
        roomId: fixture().roomId,
        authorityEpoch: 1,
        assetIds: [],
      },
      z.strictObject({ assets: z.array(z.unknown()) }),
      signal(),
    );
    expect(result).toEqual({ assets: [] });
    expect(typeof timings.readAssets).toBe("number");
    expect(timings.readAssetsStorage).toBe(2.5);
    expect(Object.keys(timings).sort()).toEqual([
      "readAssets",
      "readAssetsStorage",
    ]);
  });
  it("preserves the global receiver required by native Worker fetch", async () => {
    const nativeFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async function (this: unknown) {
      calls.push(this);
      if (this !== globalThis)
        throw new TypeError("Illegal invocation: incorrect this reference");
      return Response.json({ authorityEpoch: 2 });
    };
    try {
      const result = await new AdapterClient(config).call(
        {
          v: 1,
          action: "fence",
          roomId: fixture().roomId,
          authorityEpoch: 2,
          state: "ended",
        },
        z.strictObject({ authorityEpoch: z.number() }),
        signal(),
      );
      expect(result).toEqual({ authorityEpoch: 2 });
      expect(calls).toEqual([globalThis]);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  it("uses only the adapter capability and forbids redirects", async () => {
    let request: RequestInit | undefined;
    const c = new AdapterClient(config, async (url, init) => {
      expect(url).toBe(config.COLLAB_ADAPTER_URL);
      request = init;
      return Response.json({ authorityEpoch: 2 });
    });
    const f = fixture();
    expect(
      await c.call(
        {
          v: 1,
          action: "fence",
          roomId: f.roomId,
          authorityEpoch: 2,
          state: "ended",
        },
        z.strictObject({ authorityEpoch: z.number() }),
        signal(),
      ),
    ).toEqual({ authorityEpoch: 2 });
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${config.COLLAB_ADAPTER_SECRET}`,
        "content-type": "application/json",
      },
    });
  });

  it("constructs a supported workerd Request and rejects redirects without forwarding the capability", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.test/" },
      });
    });
    const c = new AdapterClient(config, fetchImpl);
    await expect(
      c.call(
        {
          v: 1,
          action: "cleanup",
          roomId: fixture().roomId,
          authorityEpoch: 1,
        },
        z.unknown(),
        signal(),
      ),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "",
    "http://web.example/api/internal/collaboration/adapter",
    "https://web.example/wrong",
    "https://user@web.example/api/internal/collaboration/adapter",
    `${config.COLLAB_ADAPTER_URL}?token=x`,
  ])(
    "refuses unsafe/unconfigured endpoints before I/O: %s",
    async (endpoint) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const c = new AdapterClient(
        { ...config, COLLAB_ADAPTER_URL: endpoint },
        fetchImpl,
      );
      const f = fixture();
      await expect(
        c.call(
          {
            v: 1,
            action: "cleanup",
            roomId: f.roomId,
            authorityEpoch: 1,
          },
          z.unknown(),
          signal(),
        ),
      ).rejects.toThrow("adapter-unconfigured");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("bounds actual response bytes and releases an oversized stream", async () => {
    let cancelled = false;
    const c = new AdapterClient(
      config,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(AUTHORITY_LIMITS.jobBytes + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": "1",
            },
          },
        ),
    );
    const f = fixture();
    await expect(
      c.call(
        {
          v: 1,
          action: "cleanup",
          roomId: f.roomId,
          authorityEpoch: 1,
        },
        z.unknown(),
        signal(),
      ),
    ).rejects.toThrow("adapter-response-too-large");
    expect(cancelled).toBe(true);
  });

  it.each([
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ cleaned: true, extra: "unexpected" }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ])("refuses errors and invalid response shapes", async (makeResponse) => {
    const f = fixture();
    await expect(
      client(() => makeResponse()).call(
        {
          v: 1,
          action: "cleanup",
          roomId: f.roomId,
          authorityEpoch: 1,
        },
        z.strictObject({ cleaned: z.literal(true) }),
        signal(),
      ),
    ).rejects.toThrow();
  });
});

describe("Room adapter delivery in workerd", () => {
  it("uses the configured client from the actual Room alarm handler", async () => {
    const { roomId, stub, command } = fixture();
    let configuredRoom: CollaborationRoomV2 | undefined;
    let endId = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const end = { ...command("end-room"), action: "end-room" as const };
      endId = end.operationId;
      await a.apply(end);
      configuredRoom = new CollaborationRoomV2(state, { ...env, ...config });
      // Constructor's concurrency gate completes before the next Object event.
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const calls: string[] = [];
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          if (typeof init?.body !== "string")
            throw new Error("expected-json-command");
          const c = adapterCommandSchema.parse(
            JSON.parse(init.body) as unknown,
          );
          calls.push(c.action);
          if (c.action === "fence")
            return Response.json({ authorityEpoch: c.authorityEpoch });
          if (c.action === "project") return Response.json({ applied: true });
          if (c.action === "cleanup") return Response.json({ cleaned: true });
          throw new Error("unexpected-command");
        });
      try {
        await configuredRoom!.alarm();
        expect(calls).toContain("fence");
        expect(
          new RoomAuthority(state.storage, roomId).query(endId)?.status,
        ).toBe("enforced");
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("retains failed work in the real alarm and recovers delivery after eviction", async () => {
    const { roomId, stub, command } = fixture();
    let endId = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const end = { ...command("end-room"), action: "end-room" as const };
      endId = end.operationId;
      await a.apply(end);
    });
    // Existing test environment is unconfigured: the actual handler retains jobs/backoff.
    await runDurableObjectAlarm(stub);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      expect(a.query(endId)?.status).toBe("pending");
      expect(a.state()?.fenced_epoch).toBe(1);
      expect(
        state.storage.sql
          .exec<{ attempts: number }>(
            "SELECT attempts FROM authority_work WHERE id='room-fence'",
          )
          .one().attempts,
      ).toBeGreaterThan(0);
      state.storage.sql.exec("UPDATE authority_work SET next_at=0");
      const calls: string[] = [];
      const delivery = new RoomDelivery(
        a,
        client((c) => {
          calls.push(c.action);
          if (c.action === "fence")
            return Response.json({ authorityEpoch: c.authorityEpoch });
          if (c.action === "project") return Response.json({ applied: false });
          if (c.action === "cleanup") return Response.json({ cleaned: true });
          throw new Error("unexpected-command");
        }),
      );
      await a.work.drain(
        (job, _ms, s) => delivery.deliver(job, s),
        () => a.nextDeadline(),
      );
      expect(a.query(endId)?.status).toBe("enforced");
      expect(calls).toContain("fence");
      // Cleanup ran earlier in the bounded batch and waits for a confirmed fence.
      state.storage.sql.exec("UPDATE authority_work SET next_at=0");
      await a.work.drain(
        (job, _ms, s) => delivery.deliver(job, s),
        () => a.nextDeadline(),
      );
      expect(calls).toContain("cleanup");
      expect(a.work.due()).toHaveLength(0);
    });
  });

  it("delivers invitation rows through project-invite and member rows with role and access", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      const complete = await initialize(a, command);
      await a.confirmInitialization(complete.operationId, manifest);
      const sent: AdapterCommand[] = [];
      const d = new RoomDelivery(
        a,
        client((c) => {
          sent.push(c);
          if (c.action === "fence")
            return Response.json({ authorityEpoch: c.authorityEpoch });
          // applied=false is an obsolete-row decision, not a delivery failure.
          if (c.action === "project-invite")
            return Response.json({ applied: !c.event.tombstone });
          if (c.action === "project") return Response.json({ applied: true });
          throw new Error("unexpected-command");
        }),
      );
      const drain = async () => {
        state.storage.sql.exec("UPDATE authority_work SET next_at=0");
        await a.work.drain(
          (job, _ms, s) => d.deliver(job, s),
          () => a.nextDeadline(),
        );
      };
      const row = { v: 1, roomId, status: "ready", label: "", sceneId: null };
      await a.apply({
        ...command("allow-email"),
        action: "allow-email",
        email: "Invitee@Example.com",
        role: "viewer",
      });
      await drain();
      // The invitation grants the higher of its role and general access (editor).
      expect(sent).toContainEqual({
        v: 1,
        action: "project-invite",
        event: expect.objectContaining({
          ...row,
          email: "invitee@example.com",
          role: "editor",
          tombstone: false,
        }) as unknown,
      });
      expect(sent).toContainEqual({
        v: 1,
        action: "project",
        event: expect.objectContaining({
          ...row,
          subject: actor.subject,
          role: "owner",
          access: "owned",
          tombstone: false,
        }) as unknown,
      });
      sent.length = 0;
      await a.apply({
        ...command("remove-email"),
        action: "remove-email",
        email: "invitee@example.com",
      });
      await drain();
      expect(sent).toContainEqual({
        v: 1,
        action: "project-invite",
        event: expect.objectContaining({
          email: "invitee@example.com",
          role: null,
          tombstone: true,
        }) as unknown,
      });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM authority_work WHERE id LIKE 'invite:%'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("preserves a newer coalesced fence when an older response returns", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      const complete = await initialize(a, command);
      await a.confirmInitialization(complete.operationId, manifest);
      await a.apply({
        ...command("set-link-role"),
        action: "set-link-role",
        linkRole: "viewer",
      });
      let mutated = false;
      const d = new RoomDelivery(
        a,
        client(async (c) => {
          if (c.action === "fence") {
            if (!mutated) {
              mutated = true;
              await a.apply({ ...command("end-room"), action: "end-room" });
            }
            return Response.json({ authorityEpoch: c.authorityEpoch });
          }
          return Response.json({ applied: true });
        }),
      );
      await a.work.drain(
        (job, _ms, s) => d.deliver(job, s),
        () => a.nextDeadline(),
      );
      expect(a.state()).toMatchObject({
        authority_epoch: 3,
        fenced_epoch: 2,
        state: "ended",
      });
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM authority_work WHERE id='room-fence'",
          )
          .one().version,
      ).toBe(3);
    });
  });

  it("does not acknowledge malformed/future fence responses or late aborted responses", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await initialize(a, command);
      await a.apply({ ...command("end-room"), action: "end-room" });
      const job: DurableJob = { kind: "fence", roomId, authorityEpoch: 2 };
      for (const body of [
        { authorityEpoch: 3 },
        { authorityEpoch: 2, role: "owner" },
      ])
        await expect(
          new RoomDelivery(
            a,
            client(() => Response.json(body)),
          ).deliver(job, signal()),
        ).rejects.toThrow();
      const controller = new AbortController();
      const d = new RoomDelivery(
        a,
        client(() => {
          controller.abort();
          return Response.json({ authorityEpoch: 2 });
        }),
      );
      await expect(d.deliver(job, controller.signal)).rejects.toThrow();
      expect(a.state()?.fenced_epoch).toBe(1);
    });
  });

  it("queries a lost write receipt and cancels missing bytes without retransmission", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await initialize(a, command);
      const base = command("create");
      const envelope = {
        v: base.v,
        operationId: base.operationId,
        roomId: base.roomId,
        actor: base.actor,
        deadline: base.deadline,
      };
      const content: ContentOperation = {
        ...envelope,
        kind: "snapshot-put",
        authorityEpoch: 1,
        expectedRevision: 0,
        checksum: "a".repeat(64),
      };
      await a.acceptContent(content);
      const calls: string[] = [];
      const d = new RoomDelivery(
        a,
        client((c) => {
          calls.push(c.action);
          return Response.json({ status: "written", revision: 7 });
        }),
      );
      await d.deliver({ kind: "settle-content", operation: content }, signal());
      expect(a.contentResult(content.operationId)).toEqual({
        status: "written",
        revision: 7,
      });
      expect(calls).toEqual(["query"]);
      const missing = {
        ...content,
        operationId: crypto.randomUUID(),
        deadline: Date.now() + 100,
      };
      await a.acceptContent(missing);
      const c = new RoomDelivery(
        a,
        client((cmd) => {
          calls.push(cmd.action);
          return Response.json({
            status: cmd.action === "query" ? "pending" : "cancelled",
          });
        }),
      );
      expect(
        await c.deliver(
          { kind: "settle-content", operation: missing },
          signal(),
        ),
      ).toBe(false);
      expect(calls).toEqual(["query", "query"]);
      // Persisted intent remains immutable. Advance only the test clock beyond its deadline.
      const nowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(missing.deadline + 1);
      try {
        await c.deliver(
          { kind: "settle-content", operation: missing },
          signal(),
        );
      } finally {
        nowSpy.mockRestore();
      }
      expect(calls.slice(-2)).toEqual(["query", "cancel"]);
      expect(a.contentResult(missing.operationId)).toEqual({
        status: "cancelled",
      });
    });
  });

  it("makes Room ready only after a validated adapter ready acknowledgment", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      const complete = await initialize(a, command);
      const calls: string[] = [];
      let failReady = true;
      const d = new RoomDelivery(
        a,
        client((c) => {
          calls.push(c.action);
          expect(a.state()?.state).toBe("initializing");
          if (c.action === "verify-initialization")
            return Response.json({ manifest });
          if (c.action === "fence" && failReady) {
            failReady = false;
            return new Response(null, { status: 503 });
          }
          if (c.action === "fence") return Response.json({ authorityEpoch: 1 });
          throw new Error("unexpected");
        }),
      );
      const job: DurableJob = {
        kind: "initialize",
        roomId,
        operationId: complete.operationId,
        manifest,
      };
      await expect(d.deliver(job, signal())).rejects.toThrow();
      expect(a.query(complete.operationId)?.status).toBe("pending");
      await d.deliver(job, signal());
      expect(a.state()?.state).toBe("ready");
      expect(a.query(complete.operationId)?.status).toBe("enforced");
      expect(calls).toEqual([
        "verify-initialization",
        "fence",
        "verify-initialization",
        "fence",
      ]);
    });
  });

  it("rejects a late initialization response after local cancellation and preserves terminal cleanup", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      const complete = await initialize(a, command);
      const calls: string[] = [];
      const d = new RoomDelivery(
        a,
        client(async (c) => {
          calls.push(c.action);
          await a.apply({
            ...command("cancel-initialization"),
            action: "cancel-initialization",
          });
          return Response.json({ manifest });
        }),
      );
      expect(
        await d.deliver(
          {
            kind: "initialize",
            roomId,
            operationId: complete.operationId,
            manifest,
          },
          signal(),
        ),
      ).toBe(false);
      expect(calls).toEqual(["verify-initialization"]);
      expect(a.state()?.state).toBe("ended");
      expect(a.query(complete.operationId)?.status).toBe("cancelled");
      expect(
        a.work.due().map((row) => (JSON.parse(row.body) as DurableJob).kind),
      ).toContain("cleanup");
    });
  });
  it("settles an asset receipt and its initialization manifest atomically across eviction", async () => {
    const { roomId, stub, command } = fixture();
    let operationId = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await initialize(a, command);
      const base = command("create");
      const envelope = {
        v: base.v,
        operationId: base.operationId,
        roomId: base.roomId,
        actor: base.actor,
        deadline: base.deadline,
      };
      const operation: ContentOperation = {
        ...envelope,
        kind: "asset-finalize",
        authorityEpoch: 1,
        expectedRevision: 0,
        checksum: "a".repeat(64),
        asset: {
          excalidrawFileId: "file-a",
          byteLength: 256,
          utFileKey: "provider-key",
          url: "https://files.example/asset",
        },
      };
      operationId = operation.operationId;
      await a.acceptContent(operation);
      const d = new RoomDelivery(
        a,
        client(() => Response.json({ status: "written", revision: 1 })),
      );
      await d.deliver({ kind: "settle-content", operation }, signal());
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      expect(a.contentResult(operationId)).toEqual({
        status: "written",
        revision: 1,
      });
      expect(
        state.storage.sql
          .exec<{ file_id: string }>(
            "SELECT file_id FROM authority_initial_assets",
          )
          .one().file_id,
      ).toBe("file-a");
    });
  });

  it("cancels completion work invalidated by a fence or superseded by successful readiness", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      const first = await initialize(a, command);
      // Narrowing general access fences the room, which voids pending completion.
      await a.apply({
        ...command("set-link-role"),
        action: "set-link-role",
        linkRole: "viewer",
      });
      expect(a.query(first.operationId)?.status).toBe("cancelled");
      const nextManifest = { ...manifest, revision: 2 };
      const complete = () => ({
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: nextManifest,
      });
      const second = complete();
      const third = complete();
      await a.apply(second);
      await a.apply(third);
      const d = new RoomDelivery(
        a,
        client((c) => {
          if (c.action === "verify-initialization")
            return Response.json({ manifest: nextManifest });
          if (c.action === "fence") return Response.json({ authorityEpoch: 2 });
          throw new Error("unexpected");
        }),
      );
      await d.deliver(
        {
          kind: "initialize",
          roomId,
          operationId: second.operationId,
          manifest: nextManifest,
        },
        signal(),
      );
      expect(a.query(second.operationId)?.status).toBe("enforced");
      expect(a.query(third.operationId)?.status).toBe("cancelled");
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM authority_work WHERE id LIKE 'initialize:%'",
          )
          .one().count,
      ).toBe(0);
    });
  });
});
