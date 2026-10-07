import { createHash } from "node:crypto";
import {
  env,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_METADATA_HEADER,
  SNAPSHOT_REQUEST_HEADER,
  SNAPSHOT_RECEIPT_HEADER,
  adapterCommandSchema,
  snapshotRequestSchema,
  type ContentOperation,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import {
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  MIN_SNAPSHOT_SEALED_BYTES,
} from "@drawstuff/collaboration/snapshot";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import {
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import {
  openSocket,
  expectClose,
  settleRoomEvents,
  type OpenSocket,
} from "./support/room-socket.ts";
import { RoomAuthority } from "../src/room-authority.ts";
import { SnapshotEntry } from "../src/snapshot-entry.ts";
import { AdapterClient } from "../src/adapter-client.ts";
import { RoomDelivery } from "../src/room-delivery.ts";
import { readSnapshotBody } from "../src/snapshot-body.ts";

const owner: TrustedIdentity = {
  subject: "snapshot-owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const guest: TrustedIdentity = {
  subject: "snapshot-guest",
  email: "guest@example.com",
  lifecycleVersion: 1,
};
const config: Env = {
  ...env,
  COLLAB_ADAPTER_URL: "https://adapter.test/api/internal/collaboration/adapter",
};
const bytes = new Uint8Array(MIN_SNAPSHOT_SEALED_BYTES).fill(1);
const digest = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
const restore: (() => Promise<void>)[] = [];
const sockets: OpenSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.connection.close();
  await settleRoomEvents();
  for (const reset of restore.splice(0)) await reset();
  vi.restoreAllMocks();
});
function fixture() {
  const roomId = roomIdSchema.parse(`snapshot-${crypto.randomUUID()}`);
  const stub = env.COLLABORATION_ROOM.getByName(roomId);
  const command = {
    v: 1 as const,
    roomId,
    actor: owner,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  };
  const operation: ContentOperation = {
    ...command,
    operationId: crypto.randomUUID(),
    kind: "snapshot-put",
    authorityEpoch: 1,
    authGeneration: 1,
    expectedRevision: 0,
    checksum: digest(bytes),
  };
  return { roomId, stub, command, operation };
}
function request(
  f: ReturnType<typeof fixture>,
  action: "write" | "read" | "query" | "cancel",
  body?: BodyInit,
  identity = owner,
  operation = f.operation,
) {
  const now = Math.floor(Date.now() / 1000);
  const proof = signIdentityProof(
    {
      v: 1,
      aud: "drawstuff-room-identity",
      protocolVersion: 6,
      roomId: f.roomId,
      identity,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 60,
    },
    config.COLLAB_IDENTITY_SECRET,
  );
  const { actor, ...intent } = operation;
  void actor;
  const input = snapshotRequestSchema.parse(
    action === "read"
      ? {
          action,
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
        }
      : { action, operation: intent },
  );
  return new Request("https://gateway.test/v1/snapshot", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.COLLAB_AUTHORITY_SECRET}`,
      "content-type": "application/octet-stream",
      [SNAPSHOT_REQUEST_HEADER]: JSON.stringify({ proof, request: input }),
    },
    body,
  });
}
async function create(
  a: RoomAuthority,
  f: ReturnType<typeof fixture>,
  ready = false,
) {
  await a.apply({
    ...f.command,
    action: "create",
    sceneId: null,
    label: "",
    linkRole: "editor",
  });
  await a.confirmParent(f.command.operationId);
  if (ready) {
    await a.apply({
      ...f.command,
      operationId: crypto.randomUUID(),
      action: "set-key-check",
      expectedGeneration: 1,
      keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
    });
    const manifest = {
      authGeneration: 1,
      revision: 1,
      checksum: digest(bytes),
      assetIds: [],
    };
    const complete = {
      ...f.command,
      operationId: crypto.randomUUID(),
      action: "complete-initialization" as const,
      manifest,
    };
    await a.apply(complete);
    await a.confirmFence(a.state()!.authority_epoch);
    await a.confirmInitialization(complete.operationId, manifest);
    // Content intents always bind the current epoch.
    f.operation.authorityEpoch = a.state()!.authority_epoch;
  }
}
function adapter(
  handler?: (
    command: ReturnType<typeof adapterCommandSchema.parse>,
    init: RequestInit,
  ) => Promise<Response> | Response,
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (!init) throw new Error("missing-request");
      const metadata = new Headers(init.headers).get(ADAPTER_METADATA_HEADER);
      if (!metadata && typeof init.body !== "string")
        throw new Error("missing-command");
      const command = adapterCommandSchema.parse(
        JSON.parse(metadata ?? (init.body as string)) as unknown,
      );
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${config.COLLAB_ADAPTER_SECRET}`,
      );
      expect(init.redirect).toBe("error");
      if (command.action === "register")
        return Response.json({
          roomId: command.roomId,
          operationId: command.operationId,
          subject: command.identity.subject,
          lifecycleVersion: command.identity.lifecycleVersion,
        });
      if (handler) return handler(command, init);
      throw new Error("unexpected-command");
    });
}
function snapshot(
  command: Extract<
    ReturnType<typeof adapterCommandSchema.parse>,
    { action: "read-snapshot" }
  >,
  body = bytes,
) {
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
        roomId: command.roomId,
        authGeneration: command.authGeneration,
        authorityEpoch: command.authorityEpoch,
        revision: 1,
        cryptoVersion: 1,
        byteLength: body.byteLength,
        checksum: digest(body),
      }),
    },
  });
}
async function configure(f: ReturnType<typeof fixture>, ready = false) {
  await runInDurableObject(f.stub, async (instance, state) => {
    const bindings: unknown = Reflect.get(instance, "env");
    if (!bindings || typeof bindings !== "object")
      throw new Error("missing-bindings");
    const old = Reflect.get(bindings, "COLLAB_ADAPTER_URL") as unknown;
    Object.assign(bindings, {
      COLLAB_ADAPTER_URL: config.COLLAB_ADAPTER_URL,
    });
    restore.push(() =>
      runInDurableObject(f.stub, (current) => {
        const currentBindings: unknown = Reflect.get(current, "env");
        if (currentBindings && typeof currentBindings === "object")
          Object.assign(currentBindings, { COLLAB_ADAPTER_URL: old });
      }),
    );
    await create(new RoomAuthority(state.storage, f.roomId), f, ready);
  });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("formal binary snapshot entry", () => {
  it("round-trips the maximum legal ciphertext through Gateway, streaming RPC and adapter, retaining metadata only", async () => {
    const f = fixture();
    const maximum = new Uint8Array(MAX_SNAPSHOT_CIPHERTEXT_BYTES).fill(1);
    f.operation.checksum = digest(maximum);
    let writes = 0;
    adapter((command, init) => {
      if (command.action === "write") {
        writes++;
        expect(init.body).toBeInstanceOf(Uint8Array);
        expect(digest(new Uint8Array(init.body as Uint8Array))).toBe(
          f.operation.checksum,
        );
        return Response.json({ status: "written", revision: 1 });
      }
      if (command.action === "read-snapshot") return snapshot(command, maximum);
      throw new Error("unexpected-command");
    });
    await configure(f);
    const written = await SELF.fetch(request(f, "write", maximum));
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ status: "written", revision: 1 });
    const read = await SELF.fetch(request(f, "read"));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(digest(new Uint8Array(await read.arrayBuffer()))).toBe(
      f.operation.checksum,
    );
    const retry = await SELF.fetch(request(f, "write", maximum));
    expect(await retry.json()).toEqual({ status: "written", revision: 1 });
    expect(writes).toBe(1);
    const oversize = request(
      f,
      "write",
      new Uint8Array(MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1),
    );
    oversize.headers.set("content-length", "1");
    expect((await SELF.fetch(oversize)).status).toBe(413);
    expect(
      (
        await SELF.fetch(
          request(f, "write", new Uint8Array(maximum.length).fill(2)),
        )
      ).status,
    ).toBe(400);
    await runInDurableObject(f.stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ request: string }>("SELECT request FROM authority_content")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.request.length).toBeLessThan(1_000);
      expect(rows[0]!.request).not.toContain("proof");
    });
  });
  it("rejects service/identity forgeries and oversized metadata before routing", async () => {
    const f = fixture();
    const before = (await listDurableObjectIds(env.COLLABORATION_ROOM)).length;
    const bad = request(f, "write", bytes);
    bad.headers.set("authorization", "Bearer wrong");
    expect((await SELF.fetch(bad)).status).toBe(401);
    const forged = request(f, "write", bytes);
    const input = JSON.parse(forged.headers.get(SNAPSHOT_REQUEST_HEADER)!) as {
      proof: string;
      request: { operation: { roomId: string } };
    };
    input.request.operation.roomId = "another-room";
    forged.headers.set(SNAPSHOT_REQUEST_HEADER, JSON.stringify(input));
    expect((await SELF.fetch(forged)).status).toBe(401);
    const actor = request(f, "write", bytes);
    const json = JSON.parse(actor.headers.get(SNAPSHOT_REQUEST_HEADER)!) as {
      request: { operation: Record<string, unknown> };
    };
    json.request.operation.actor = owner;
    actor.headers.set(SNAPSHOT_REQUEST_HEADER, JSON.stringify(json));
    expect((await SELF.fetch(actor)).status).toBe(400);
    expect((await listDurableObjectIds(env.COLLABORATION_ROOM)).length).toBe(
      before,
    );
  });
  it("rejects actual oversized bytes despite Content-Length, and releases the quota on failure", async () => {
    const f = fixture();
    let writes = 0;
    adapter(() => {
      writes++;
      return Response.json({ status: "written", revision: 1 });
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f);
      const entry = new SnapshotEntry(a, config);
      for (let i = 0; i < 3; i++) {
        const oversize = request(
          f,
          "write",
          new Uint8Array(MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1),
        );
        oversize.headers.set("content-length", "1");
        expect((await entry.handle(oversize)).status).toBe(413);
      }
      expect(writes).toBe(0);
      expect((await entry.handle(request(f, "write", bytes))).status).toBe(200);
    });
  });
  it("leaves a lost write reply pending, then recovers the original receipt after eviction without rewriting", async () => {
    const f = fixture();
    let writes = 0;
    f.operation.expectedRevision = 6;
    adapter((command) => {
      if (command.action === "write") {
        writes++;
        throw new Error("lost-reply-after-commit");
      }
      if (command.action === "query")
        return Response.json({ status: "written", revision: 7 });
      throw new Error("unexpected-command");
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f);
      expect(
        (await new SnapshotEntry(a, config).handle(request(f, "write", bytes)))
          .status,
      ).toBe(503);
      expect(a.queryContent(f.operation)).toEqual({ status: "pending" });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await evictDurableObject(f.stub);
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      const query = await new SnapshotEntry(a, config).handle(
        request(f, "query"),
      );
      expect(await query.json()).toEqual({ status: "written", revision: 7 });
      expect(a.queryContent(f.operation)).toEqual({
        status: "written",
        revision: 7,
      });
    });
    expect(writes).toBe(1);
  });
  it("cancels a missing body and refuses changed immutable intents or another actor's receipt", async () => {
    const f = fixture();
    adapter((command) => {
      expect(command.action).toBe("cancel");
      return Response.json({ status: "cancelled" });
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f, true);
      const entry = new SnapshotEntry(a, config);
      await a.acceptContent(f.operation);
      expect(
        (await entry.handle(request(f, "query", undefined, guest))).status,
      ).toBe(409);
      expect(
        (
          await entry.handle(
            request(f, "query", undefined, owner, {
              ...f.operation,
              checksum: "b".repeat(64),
            }),
          )
        ).status,
      ).toBe(409);
      expect(await (await entry.handle(request(f, "cancel"))).json()).toEqual({
        status: "cancelled",
      });
      expect(
        await (await entry.handle(request(f, "write", bytes))).json(),
      ).toEqual({ status: "cancelled" });
    });
  });
  it("rejects stale live registration, initialization guests, viewers and non-owner resets", async () => {
    const f = fixture();
    adapter();
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f);
      const entry = new SnapshotEntry(a, config);
      expect(
        (await entry.handle(request(f, "write", bytes, guest))).status,
      ).toBe(403);
      await a.apply({
        ...f.command,
        operationId: crypto.randomUUID(),
        action: "cancel-initialization",
      });
      expect((await entry.handle(request(f, "write", bytes))).status).toBe(403);
    });
    const ready = fixture();
    await runInDurableObject(ready.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, ready.roomId);
      await create(a, ready, true);
      const entry = new SnapshotEntry(a, config);
      expect(
        (
          await entry.handle(
            request(ready, "write", undefined, guest, {
              ...ready.operation,
              kind: "snapshot-reset",
            }),
          )
        ).status,
      ).toBe(403);
      await a.apply({
        ...ready.command,
        operationId: crypto.randomUUID(),
        action: "set-link-role",
        linkRole: "viewer",
      });
      expect(
        (await entry.handle(request(ready, "write", bytes, guest))).status,
      ).toBe(403);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({
          roomId: ready.roomId,
          operationId: ready.operation.operationId,
          subject: owner.subject,
          lifecycleVersion: 2,
        }),
      );
      expect((await entry.handle(request(ready, "write", bytes))).status).toBe(
        409,
      );
      expect(a.queryContent(ready.operation)).toBeUndefined();
    });
  });
  it("reserves only two bodies while metadata queries and local revocation remain live", async () => {
    const f = fixture();
    const entered = gate();
    const unblock = gate();
    let arrivals = 0;
    adapter(async (command) => {
      if (command.action === "read-snapshot") {
        if (++arrivals === 2) entered.release();
        await unblock.promise;
        return snapshot(command);
      }
      if (command.action === "query")
        return Response.json({ status: "pending" });
      throw new Error("unexpected-command");
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f, true);
      const entry = new SnapshotEntry(a, config);
      await a.acceptContent(f.operation);
      const first = entry.handle(request(f, "read", undefined, guest));
      const second = entry.handle(request(f, "read", undefined, guest));
      await entered.promise;
      expect((await entry.handle(request(f, "read"))).status).toBe(429);
      expect(await (await entry.handle(request(f, "query"))).json()).toEqual({
        status: "pending",
      });
      await a.apply({
        ...f.command,
        operationId: crypto.randomUUID(),
        action: "revoke-member",
        subject: guest.subject,
      });
      unblock.release();
      expect((await first).status).toBe(403);
      expect((await second).status).toBe(403);
      const next = await entry.handle(request(f, "read"));
      expect(next.status).toBe(200);
      await next.body?.cancel();
    });
  });
  it("holds read quota until cancellation and rechecks revocation before later response chunks", async () => {
    const f = fixture();
    const payload = new Uint8Array(200_000).fill(1);
    adapter((command) => {
      if (command.action === "read-snapshot") return snapshot(command, payload);
      throw new Error("unexpected-command");
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f, true);
      const entry = new SnapshotEntry(a, config);
      const first = await entry.handle(request(f, "read", undefined, guest));
      const second = await entry.handle(request(f, "read"));
      expect((await entry.handle(request(f, "read"))).status).toBe(429);
      await second.body!.cancel();
      const reader =
        first.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      let delivered = (await reader.read()).value!.byteLength;
      expect(delivered).toBeGreaterThan(0);
      await a.apply({
        ...f.command,
        operationId: crypto.randomUUID(),
        action: "revoke-member",
        subject: guest.subject,
      });
      // Bytes already enqueued before revocation cannot be recalled.
      let failure: unknown;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          delivered += chunk.value.byteLength;
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("forbidden");
      expect(delivered).toBeLessThanOrEqual(65_536);
      const next = await entry.handle(request(f, "read"));
      expect(next.status).toBe(200);
      await next.body!.cancel();
    });
  });
  it("keeps initialization blocked until an acknowledged binary snapshot and verified manifest become ready", async () => {
    const f = fixture();
    adapter((command) => {
      if (command.action === "write")
        return Response.json({ status: "written", revision: 1 });
      if (command.action === "verify-initialization")
        return Response.json({ manifest: command.manifest });
      if (command.action === "fence")
        return Response.json({ authorityEpoch: command.authorityEpoch });
      throw new Error("unexpected-command");
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f);
      const entry = new SnapshotEntry(a, config);
      expect(
        (await entry.handle(request(f, "read", undefined, guest))).status,
      ).toBe(403);
      expect(
        await (await entry.handle(request(f, "write", bytes))).json(),
      ).toEqual({ status: "written", revision: 1 });
      await a.apply({
        ...f.command,
        operationId: crypto.randomUUID(),
        action: "set-key-check",
        expectedGeneration: 1,
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const operationId = crypto.randomUUID();
      const manifest = {
        authGeneration: 1,
        revision: 1,
        checksum: digest(bytes),
        assetIds: [],
      };
      await a.apply({
        ...f.command,
        operationId,
        action: "complete-initialization",
        manifest,
      });
      const job = {
        kind: "initialize" as const,
        operationId,
        roomId: f.roomId,
        manifest,
      };
      await new RoomDelivery(a, new AdapterClient(config)).deliver(
        job,
        new AbortController().signal,
      );
      expect(a.state()!.state).toBe("ready");
      expect(a.role(guest)).toBe("editor");
    });
  });
  it("keeps actual WebSocket fanout and management live while a binary adapter read stalls", async () => {
    const f = fixture();
    let entered = false;
    let unblocked = false;
    adapter(async (command) => {
      if (command.action === "read-snapshot") {
        entered = true;
        while (!unblocked)
          await new Promise((resolve) => setTimeout(resolve, 10));
        return snapshot(command);
      }
      if (command.action === "project") return Response.json({ applied: true });
      if (command.action === "fence")
        return Response.json({ authorityEpoch: command.authorityEpoch });
      throw new Error("unexpected-command");
    });
    await configure(f, true);
    const connect = async (identity: TrustedIdentity) => {
      const socket = await openSocket(f.roomId, 1, true);
      sockets.push(socket);
      const envelope = JSON.parse(
        request(f, "read", undefined, identity).headers.get(
          SNAPSHOT_REQUEST_HEADER,
        )!,
      ) as { proof: string };
      socket.connection.send(
        JSON.stringify({
          control: "join",
          protocolVersion: 6,
          roomId: f.roomId,
          token: envelope.proof,
        }),
      );
      const notice = await socket.connection.next();
      expect(notice.kind).toBe("text");
      if (notice.kind === "text")
        expect(parseRelayServerControl(notice.text)?.control).toBe("joined");
      return socket;
    };
    const sender = await connect(owner);
    const receiver = await connect(guest);
    const slow = SELF.fetch(request(f, "read", undefined, guest));
    try {
      const deadline = Date.now() + 5_000;
      while (!entered) {
        if (Date.now() > deadline) throw new Error("read-not-entered");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const frame = encodeRelayDataFrame("scene", new Uint8Array([4, 5, 6]));
      sender.connection.send(frame);
      let delivered = false;
      for (let n = 0; n < 128; n++) {
        const event = await receiver.connection.next();
        if (event.kind === "binary") {
          expect(event.bytes).toEqual(frame);
          delivered = true;
          break;
        }
        if (event.kind === "close") throw new Error("unexpected-close");
      }
      expect(delivered).toBe(true);
      const proof = (
        JSON.parse(
          request(f, "read").headers.get(SNAPSHOT_REQUEST_HEADER)!,
        ) as { proof: string }
      ).proof;
      const revoke = await SELF.fetch("https://gateway.test/v1/authority", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.COLLAB_AUTHORITY_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          proof,
          request: {
            v: 1,
            roomId: f.roomId,
            operationId: crypto.randomUUID(),
            deadline: Date.now() + 55_000,
            action: "revoke-member",
            subject: guest.subject,
          },
        }),
      });
      expect(revoke.status).toBe(200);
      await expectClose(
        receiver.connection,
        RELAY_CLOSE_CODES.membershipRevoked,
      );
    } finally {
      unblocked = true;
    }
    expect((await slow).status).toBe(403);
  });
  it("rechecks authorization after a stalled inbound body and never forwards revoked bytes", async () => {
    const f = fixture();
    const entered = gate();
    let bodyController!: ReadableByteStreamController;
    let writes = 0;
    adapter(() => {
      writes++;
      return Response.json({ status: "written", revision: 1 });
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f, true);
      const stream = new ReadableStream({
        type: "bytes",
        start(controller) {
          bodyController = controller;
        },
        pull() {
          entered.release();
        },
      });
      const response = new SnapshotEntry(a, config).handle(
        request(f, "write", stream, guest),
      );
      await entered.promise;
      await a.apply({
        ...f.command,
        operationId: crypto.randomUUID(),
        action: "revoke-member",
        subject: guest.subject,
      });
      bodyController.enqueue(bytes.slice());
      bodyController.close();
      expect((await response).status).toBe(403);
      expect(writes).toBe(0);
    });
  });
  it("refuses corrupt or oversized adapter responses without exposing bytes as client errors", async () => {
    const f = fixture();
    let mode = "checksum";
    adapter((command) => {
      if (command.action !== "read-snapshot")
        throw new Error("unexpected-command");
      const response = snapshot(command);
      if (mode === "checksum")
        return new Response(new Uint8Array(bytes.length).fill(2), {
          headers: response.headers,
        });
      if (mode === "identity") {
        const receipt = JSON.parse(
          response.headers.get(SNAPSHOT_RECEIPT_HEADER)!,
        ) as Record<string, unknown>;
        receipt.roomId = "another-room";
        response.headers.set(SNAPSHOT_RECEIPT_HEADER, JSON.stringify(receipt));
        return response;
      }
      return new Response(new Uint8Array(MAX_SNAPSHOT_CIPHERTEXT_BYTES + 1), {
        headers: response.headers,
      });
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f);
      const entry = new SnapshotEntry(a, config);
      for (const testMode of ["checksum", "identity", "oversize"]) {
        mode = testMode;
        expect((await entry.handle(request(f, "read"))).status).toBe(503);
      }
    });
  });
  it("refuses unconfirmed/expired initialization and treats malformed adapter JSON as unavailable", async () => {
    const f = fixture();
    const calls = adapter(
      () =>
        new Response("{broken", {
          headers: { "content-type": "application/json" },
        }),
    );
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await a.apply({
        ...f.command,
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "editor",
      });
      const entry = new SnapshotEntry(a, config);
      expect((await entry.handle(request(f, "read"))).status).toBe(409);
      expect(calls).not.toHaveBeenCalled();
      await a.confirmParent(f.command.operationId);
      expect((await entry.handle(request(f, "write", bytes))).status).toBe(503);
      expect(a.contentResult(f.operation.operationId)).toEqual({
        status: "pending",
      });
      state.storage.sql.exec(
        "UPDATE authority_room SET initialization_deadline=?",
        Date.now() - 1,
      );
      expect((await entry.handle(request(f, "read"))).status).toBe(409);
    });
  });
  it("preserves a missing snapshot's revision and rechecks a late absence after revocation", async () => {
    const f = fixture();
    let revoke: (() => Promise<void>) | undefined;
    adapter(async (command) => {
      if (command.action !== "read-snapshot")
        throw new Error("unexpected-command");
      await revoke?.();
      return Response.json(
        { error: "not-found" },
        {
          status: 404,
          headers: {
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
              roomId: f.roomId,
              authGeneration: command.authGeneration,
              authorityEpoch: command.authorityEpoch,
              revision: 2,
            }),
          },
        },
      );
    });
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      await create(a, f, true);
      const entry = new SnapshotEntry(a, config);
      const missing = await entry.handle(request(f, "read", undefined, guest));
      expect(missing.status).toBe(404);
      expect(
        JSON.parse(missing.headers.get(SNAPSHOT_RECEIPT_HEADER)!) as unknown,
      ).toMatchObject({ revision: 2 });
      revoke = async () => {
        await a.apply({
          ...f.command,
          operationId: crypto.randomUUID(),
          action: "revoke-member",
          subject: guest.subject,
        });
      };
      const late = await entry.handle(request(f, "read", undefined, guest));
      expect(late.status).toBe(403);
      expect(late.headers.has(SNAPSHOT_RECEIPT_HEADER)).toBe(false);
    });
  });
  it("cancels stalled body readers on abort without waiting for another chunk", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({
      type: "bytes",
      cancel() {
        cancelled = true;
      },
    });
    const reading = readSnapshotBody(stream, 100, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
