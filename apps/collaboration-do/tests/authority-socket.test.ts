import {
  env,
  evictDurableObject,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adapterCommandSchema,
  type AuthorityRequest,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import {
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import { RoomAuthority } from "../src/room-authority.ts";
import { readRoomSocketAttachment } from "../src/attachment.ts";
import {
  expectClose,
  expectPeers,
  issueJoinToken,
  openSocket,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
  type OpenSocket,
} from "./support/room-socket.ts";

const owner: TrustedIdentity = {
  subject: "socket-owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const guest: TrustedIdentity = {
  subject: "socket-guest",
  email: "guest@example.com",
  lifecycleVersion: 1,
};
const sockets: OpenSocket[] = [];
const restore: (() => Promise<void>)[] = [];
const platformFetch = globalThis.fetch;
let registrationReply: typeof adapterReply | undefined;
function parseAdapterCommand(init?: RequestInit) {
  if (typeof init?.body !== "string") throw new Error("expected-json-command");
  return adapterCommandSchema.parse(JSON.parse(init.body) as unknown);
}
const adapterReply = async (
  _url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const command = parseAdapterCommand(init);
  switch (command.action) {
    case "register":
      return Response.json({
        roomId: command.roomId,
        operationId: command.operationId,
        subject: command.identity.subject,
        lifecycleVersion: command.identity.lifecycleVersion,
        ...(command.targetSubject
          ? { targetSubject: command.targetSubject, targetVersion: 1 }
          : {}),
      });
    case "create-parent":
      return Response.json({
        roomId: command.roomId,
        createOperationId: command.createOperationId,
      });
    case "project":
      return Response.json({ applied: true });
    case "fence":
      return Response.json({ authorityEpoch: command.authorityEpoch });
    case "cleanup":
      return Response.json({ cleaned: true });
    default:
      throw new Error("unexpected-adapter-command");
  }
};
beforeEach(() => {
  registrationReply = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.hostname !== "adapter.test") return platformFetch(url, init);
    const command = parseAdapterCommand(init);
    if (command.action === "register" && registrationReply) {
      const reply = registrationReply;
      registrationReply = undefined;
      return reply(url, init);
    }
    return adapterReply(url, init);
  });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.connection.close();
  await settleRoomEvents();
  for (const reset of restore.splice(0)) await reset();
  vi.restoreAllMocks();
});
async function fixture(linkRole: "none" | "viewer" | "editor" = "editor") {
  const roomId = uniqueRoomId("authority-socket");
  const stub = roomStub(roomId);
  let original = "";
  let authorityForRace: RoomAuthority | undefined;
  await runInDurableObject(stub, async (instance, state) => {
    const bindings: unknown = Reflect.get(instance, "env");
    if (
      !bindings ||
      typeof bindings !== "object" ||
      !("COLLAB_ADAPTER_URL" in bindings)
    )
      throw new Error("missing-bindings");
    original = String(bindings.COLLAB_ADAPTER_URL);
    Object.assign(bindings, {
      COLLAB_ADAPTER_URL:
        "https://adapter.test/api/internal/collaboration/adapter",
    });
    const authority = new RoomAuthority(state.storage, roomId);
    authorityForRace = authority;
    const create = {
      v: 1 as const,
      action: "create" as const,
      operationId: crypto.randomUUID(),
      roomId,
      actor: owner,
      deadline: Date.now() + 55_000,
      sceneId: null,
      label: "Socket fixture",
      linkRole,
    };
    await authority.apply(create);
    await authority.confirmParent(create.operationId);
    // Seed only readiness: product snapshot/asset initialization belongs to the next entry unit.
    state.storage.sql.exec("UPDATE authority_room SET state='ready'");
  });
  restore.push(() =>
    runInDurableObject(stub, (instance) => {
      const bindings: unknown = Reflect.get(instance, "env");
      if (bindings && typeof bindings === "object")
        Object.assign(bindings, { COLLAB_ADAPTER_URL: original });
    }),
  );
  const base = () => ({
    v: 1 as const,
    roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  });
  const retire = async (subject: string, version: number) => {
    if (!authorityForRace) throw new Error("missing-authority");
    await authorityForRace.retireSubject(subject, version);
  };
  return { roomId, stub, base, retire };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function proof(f: Fixture, identity = owner, skew = 0) {
  const now = Math.floor(Date.now() / 1000) + skew;
  return signIdentityProof(
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
    env.COLLAB_IDENTITY_SECRET,
  );
}
async function connect(f: Fixture, token = proof(f)) {
  const socket = await openSocket(f.roomId, 1, true);
  sockets.push(socket);
  socket.connection.send(
    JSON.stringify({
      control: "join",
      protocolVersion: 6,
      roomId: f.roomId,
      token,
    }),
  );
  return socket;
}
async function joined(socket: OpenSocket) {
  const event = await socket.connection.next();
  if (event.kind !== "text")
    throw new Error(`expected join, got ${event.kind}`);
  const control = parseRelayServerControl(event.text);
  if (control?.control !== "joined") throw new Error("expected-joined");
  return control;
}
async function manage(f: Fixture, request: AuthorityRequest) {
  return SELF.fetch("https://gateway.test/v1/authority", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.COLLAB_AUTHORITY_SECRET}`,
    },
    body: JSON.stringify({ proof: proof(f), request }),
  });
}
const sceneFrame = encodeRelayDataFrame("scene", new Uint8Array([5, 6, 7]));
async function binary(socket: OpenSocket) {
  for (let n = 0; n < 128; n++) {
    const event = await socket.connection.next();
    if (event.kind === "binary") return event.bytes;
    if (event.kind === "close")
      throw new Error(`unexpected close ${event.code}`);
  }
  throw new Error("missing-binary-frame");
}
describe("formal Room WebSocket authority", () => {
  it("admits registered identities, assigns Room roles and preserves opaque fanout across eviction", async () => {
    const f = await fixture();
    const first = await connect(f);
    expect((await joined(first)).role).toBe("owner");
    const second = await connect(f, proof(f, guest));
    expect((await joined(second)).role).toBe("editor");
    await expectPeers(first.connection);
    await evictDurableObject(f.stub);
    await runInDurableObject(f.stub, (_instance, state) => {
      const attached = state.getWebSockets().map(readRoomSocketAttachment);
      expect(
        attached.every(
          (a) => a?.v === 3 && a.state === "joined" && a.lifecycleVersion === 1,
        ),
      ).toBe(true);
      expect(attached).toHaveLength(2);
      expect(JSON.stringify(attached)).not.toContain("proof");
    });
    first.connection.send(sceneFrame);
    expect(await binary(second)).toEqual(sceneFrame);
  });
  it("refuses legacy tokens, expired/wrong-room proofs, and forged routing headers", async () => {
    const f = await fixture();
    for (const token of [
      issueJoinToken({ roomId: f.roomId }),
      proof(f, guest, -3_600),
      proof({ ...f, roomId: uniqueRoomId("wrong") }),
    ]) {
      await expectClose(
        (await connect(f, token)).connection,
        RELAY_CLOSE_CODES.unauthorized,
      );
    }
    const legacy = await SELF.fetch(
      `https://gateway.test/v1/rooms/${f.roomId}/generations/1/socket`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "http://localhost:3000",
          "x-drawstuff-internal-authority-socket": "1",
        },
      },
    );
    expect(legacy.status).toBe(503);
    const missing = await SELF.fetch(
      `https://gateway.test/v1/rooms/${uniqueRoomId("missing")}/socket`,
      {
        headers: { Upgrade: "websocket", Origin: "http://localhost:3000" },
      },
    );
    expect(missing.status).toBe(503);
    expect(
      (
        await SELF.fetch(`https://gateway.test/v1/rooms/${f.roomId}/socket`, {
          headers: { Upgrade: "websocket", Origin: "https://untrusted.test" },
        })
      ).status,
    ).toBe(403);
  });
  it("closes revoked members promptly and does not disconnect unaffected members on ordinary management", async () => {
    const f = await fixture();
    const first = await connect(f);
    await joined(first);
    const second = await connect(f, proof(f, guest));
    await joined(second);
    await expectPeers(first.connection);
    const response = await manage(f, {
      ...f.base(),
      action: "revoke-member",
      subject: guest.subject,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { status: "pending" },
    });
    await expectClose(second.connection, RELAY_CLOSE_CODES.membershipRevoked);
    const newcomer = {
      ...guest,
      subject: "another",
      email: "another@example.com",
    };
    const third = await connect(f, proof(f, newcomer));
    await joined(third);
    first.connection.send(sceneFrame);
    expect(await binary(third)).toEqual(sceneFrame);
    await expectClose(
      (await connect(f, proof(f, guest))).connection,
      RELAY_CLOSE_CODES.membershipRevoked,
    );
  });
  it("rechecks receiving access after a missed close and checks sending roles after a downgrade", async () => {
    const f = await fixture();
    const first = await connect(f);
    await joined(first);
    const second = await connect(f, proof(f, guest));
    await joined(second);
    await expectPeers(first.connection);
    // Simulate durable mutation + crash before RPC socket cleanup.
    await runInDurableObject(f.stub, async (_instance, state) => {
      await new RoomAuthority(state.storage, f.roomId).apply({
        ...f.base(),
        actor: owner,
        action: "revoke-member",
        subject: guest.subject,
      });
    });
    await evictDurableObject(f.stub);
    first.connection.send(sceneFrame);
    await expectClose(second.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await manage(f, {
      ...f.base(),
      action: "set-member-role",
      subject: guest.subject,
      role: "viewer",
    });
    const viewer = await connect(f, proof(f, guest));
    expect((await joined(viewer)).role).toBe("viewer");
    viewer.connection.send(sceneFrame);
    await expectClose(viewer.connection, RELAY_CLOSE_CODES.readOnlyRole);
  });
  it("refuses a registration response that returns after local retirement", async () => {
    const f = await fixture();
    registrationReply = async (url, init) => {
      // Runs inside this same Room's outbound call, before the registration receipt returns.
      await f.retire(guest.subject, 2);
      return adapterReply(url, init);
    };
    const socket = await connect(f, proof(f, guest));
    await expectClose(socket.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(
        state
          .getWebSockets()
          .map(readRoomSocketAttachment)
          .some((a) => a?.state === "joined"),
      ).toBe(false);
    });
  });
  it("fails closed on adapter failure or mismatched registration, without acknowledging a join", async () => {
    const f = await fixture();
    registrationReply = async () => new Response(null, { status: 503 });
    await expectClose(
      (await connect(f, proof(f, guest))).connection,
      RELAY_CLOSE_CODES.internalError,
    );
    registrationReply = async () =>
      Response.json({
        roomId: f.roomId,
        operationId: crypto.randomUUID(),
        subject: guest.subject,
        lifecycleVersion: 1,
      });
    await expectClose(
      (await connect(f, proof(f, guest))).connection,
      RELAY_CLOSE_CODES.membershipRevoked,
    );
  });
  it("does not activate membership when the proof expires during registration", async () => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    registrationReply = async (url, init) => {
      clock.mockReturnValue(now + 61_000);
      return adapterReply(url, init);
    };
    try {
      await expectClose(
        (await connect(f, proof(f, guest))).connection,
        RELAY_CLOSE_CODES.membershipRevoked,
      );
      await runInDurableObject(f.stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              "SELECT subject FROM authority_members WHERE subject=?",
              guest.subject,
            )
            .toArray(),
        ).toHaveLength(0);
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("closes generation cohorts and keeps the same Room authority on the generation-free route", async () => {
    const f = await fixture();
    const first = await connect(f);
    const initial = await joined(first);
    await manage(f, {
      ...f.base(),
      action: "rotate-generation",
      expectedGeneration: 1,
    });
    await expectClose(first.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await expect(openSocket(f.roomId, 1, true)).rejects.toThrow("status 503");
    await runInDurableObject(f.stub, (_instance, state) =>
      state.storage.sql.exec("UPDATE authority_room SET state='ready'"),
    );
    const second = await connect(f);
    expect((await joined(second)).roomGeneration).toBeGreaterThan(
      initial.roomGeneration,
    );
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(
        new RoomAuthority(state.storage, f.roomId).state()?.auth_generation,
      ).toBe(2);
      expect(
        state
          .getWebSockets()
          .map(readRoomSocketAttachment)
          .some((a) => a?.state === "joined" && a.authGeneration === 2),
      ).toBe(true);
    });
    await manage(f, { ...f.base(), action: "end-room" });
    await expectClose(second.connection, RELAY_CLOSE_CODES.roomEnded);
  });
});
