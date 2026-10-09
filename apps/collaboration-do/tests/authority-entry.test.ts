import {
  env,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthorityRequest,
  type TrustedIdentity,
  AUTHORITY_LIMITS,
  adapterCommandSchema,
} from "@drawstuff/collaboration/authority";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { RoomAuthority } from "../src/room-authority.ts";
import { applyAuthorityEntry } from "../src/authority-entry.ts";
import { RoomDelivery } from "../src/room-delivery.ts";
import { AdapterClient } from "../src/adapter-client.ts";
import { TEST_IDENTITY_SECRET } from "./support/audit.ts";
import {
  defaultAdapterReply,
  TEST_ADAPTER_URL,
} from "./support/room-socket.ts";
const IDENTITY_SECRET = TEST_IDENTITY_SECRET;
const SERVICE_SECRET = "test-authority-secret-purpose-only-0001";
const config: Env = {
  ...env,
  COLLAB_ADAPTER_URL: TEST_ADAPTER_URL,
};
const owner: TrustedIdentity = {
  subject: "owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const guest: TrustedIdentity = {
  subject: "guest",
  email: "guest@example.com",
  lifecycleVersion: 1,
};
function fixture() {
  const roomId = roomIdSchema.parse(`entry-${crypto.randomUUID()}`);
  const stub = env.COLLABORATION_ROOM.getByName(roomId);
  const create: AuthorityRequest = {
    v: 1,
    roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
    action: "create",
    sceneId: null,
    label: "Independent",
    linkRole: "none",
  };
  return { roomId, stub, create };
}
function proof(
  request: AuthorityRequest,
  identity = owner,
  secret = IDENTITY_SECRET,
  skew = 0,
) {
  const now = Math.floor(Date.now() / 1000) + skew;
  return signIdentityProof(
    {
      v: 1,
      aud: "drawstuff-room-identity",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: request.roomId,
      identity,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 60,
    },
    secret,
  );
}
function mockAdapter() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("expected-json-command");
      return defaultAdapterReply(
        adapterCommandSchema.parse(JSON.parse(init.body) as unknown),
      );
    });
}
function post(body: unknown, secret = SERVICE_SECRET) {
  return SELF.fetch("https://gateway.test/v1/authority", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
describe("formal authority Gateway", () => {
  it("persists invitation removal during adapter failure without granting offline access", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    const allowlist = (state: DurableObjectState) =>
      state.storage.sql.exec("SELECT * FROM authority_allowlist").toArray();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        const invite: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "allow-email",
          email: guest.email,
          role: "editor",
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(invite), request: invite },
            config,
          ),
        ).toMatchObject({ ok: true });
        fetchSpy.mockRejectedValue(new Error("adapter-offline"));
        fetchSpy.mockClear();
        const remove: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "remove-email",
          email: guest.email,
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(remove, guest), request: remove },
            config,
          ),
        ).toMatchObject({ ok: false, error: "forbidden" });
        const result = await applyAuthorityEntry(
          a,
          { proof: proof(remove), request: remove },
          config,
        );
        expect(result).toMatchObject({
          ok: true,
          result: { status: "pending" },
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(remove), request: remove },
            config,
          ),
        ).toEqual(result);
        expect(allowlist(state)).toEqual([]);
        // Removal skips registration entirely: it must work while the web adapter is down.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(
          await applyAuthorityEntry(
            a,
            {
              proof: proof(invite),
              request: { ...invite, operationId: crypto.randomUUID() },
            },
            config,
          ),
        ).toMatchObject({ ok: false, error: "unavailable" });
        expect(allowlist(state)).toEqual([]);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("routes a verified management request through the actual private Room RPC", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    const originalUrl = env.COLLAB_ADAPTER_URL;
    // Configure only this test Object; production ingress receives configuration through bindings.
    const changeAdapterUrl = (url: string) =>
      runInDurableObject(f.stub, (instance) => {
        const bindings: unknown = Reflect.get(instance, "env");
        if (!bindings || typeof bindings !== "object")
          throw new Error("missing-bindings");
        Object.assign(bindings, { COLLAB_ADAPTER_URL: url });
      });
    await changeAdapterUrl(config.COLLAB_ADAPTER_URL);
    try {
      const response = await post({
        request: f.create,
        proof: proof(f.create),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        result: { operationId: f.create.operationId, status: "pending" },
      });
      await runInDurableObject(f.stub, (_instance, state) =>
        expect(
          new RoomAuthority(state.storage, f.roomId).state(),
        ).toMatchObject({
          owner: owner.subject,
          state: "initializing",
        }),
      );
    } finally {
      await changeAdapterUrl(originalUrl);
      fetchSpy.mockRestore();
    }
  });
  it("rejects missing service capability and invalid proofs before creating an Object", async () => {
    const f = fixture();
    const count = (await listDurableObjectIds(env.COLLABORATION_ROOM)).length;
    expect((await post({ invalid: true }, "wrong")).status).toBe(401);
    for (const token of [
      proof(f.create, owner, "different-identity-secret-purpose-0001"),
      proof(f.create, owner, IDENTITY_SECRET, -3_600),
    ])
      expect((await post({ request: f.create, proof: token })).status).toBe(
        401,
      );
    expect(
      (
        await post({
          request: { ...f.create, roomId: "another-room" },
          proof: proof(f.create),
        })
      ).status,
    ).toBe(401);
    expect((await listDurableObjectIds(env.COLLABORATION_ROOM)).length).toBe(
      count,
    );
  });
  it("refuses forged actors/versions and oversized JSON, and does not auto-create a missing room", async () => {
    const f = fixture();
    expect(
      (
        await post({
          request: { ...f.create, actor: owner },
          proof: proof(f.create),
        })
      ).status,
    ).toBe(400);
    const read: AuthorityRequest = { ...f.create, action: "get-state" };
    // Remove create-only fields for this strict request.
    const request = {
      v: read.v,
      roomId: read.roomId,
      operationId: read.operationId,
      deadline: read.deadline,
      action: "get-state" as const,
    };
    expect((await post({ request, proof: proof(request) })).status).toBe(404);
    const response = await SELF.fetch("https://gateway.test/v1/authority", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_SECRET}`,
        "content-type": "application/json",
        "content-length": "1",
      },
      body: " ".repeat(AUTHORITY_LIMITS.jobBytes + 1),
    });
    expect(response.status).toBe(413);
    await runInDurableObject(f.stub, (_instance, state) =>
      expect(
        new RoomAuthority(state.storage, f.roomId).state(),
      ).toBeUndefined(),
    );
  });
});
describe("registered Room authority entry", () => {
  it("persists accepted creation and its parent job across eviction, without trusting a role", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        const response = await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        expect(response).toMatchObject({
          ok: true,
          result: { status: "pending" },
        });
        expect(a.state()).toMatchObject({
          owner: "owner",
          state: "initializing",
        });
      });
      await evictDurableObject(f.stub);
      await runInDurableObject(f.stub, async (instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        const replay = await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        expect(replay).toMatchObject({
          ok: true,
          result: { status: "pending" },
        });
        const d = new RoomDelivery(a, new AdapterClient(config));
        await a.work.drain(
          (job, _ms, signal) => d.deliver(job, signal),
          () => a.nextDeadline(),
        );
        expect(a.query(f.create.operationId)?.status).toBe("enforced");
        const response = await instance.fetch(
          new Request("https://room.internal/socket", {
            headers: {
              Upgrade: "websocket",
              "x-drawstuff-internal-room-id": f.roomId,
            },
          }),
        );
        expect(response.status).toBe(503);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("does not activate on failed/mismatched registration or a late retirement response", async () => {
    const f = fixture();
    await runInDurableObject(f.stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, f.roomId);
      for (const response of [
        new Response(null, { status: 503 }),
        Response.json({
          roomId: f.roomId,
          operationId: f.create.operationId,
          subject: "owner",
          lifecycleVersion: 99,
        }),
      ]) {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(response);
        try {
          expect(
            await applyAuthorityEntry(
              a,
              { proof: proof(f.create), request: f.create },
              config,
            ),
          ).toMatchObject({ ok: false });
        } finally {
          fetchSpy.mockRestore();
        }
        expect(a.state()).toBeUndefined();
      }
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => {
          await a.retireSubject(owner.subject, 2);
          return Response.json({
            roomId: f.roomId,
            operationId: f.create.operationId,
            subject: "owner",
            lifecycleVersion: 1,
          });
        });
      try {
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(f.create), request: f.create },
            config,
          ),
        ).toMatchObject({ ok: false, error: "stale-proof" });
      } finally {
        fetchSpy.mockRestore();
      }
      expect(a.state()).toBeUndefined();
    });
  });
  it("refuses non-owner commands before registration and binds result queries to their actor", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    const request = <T extends { action: AuthorityRequest["action"] }>(
      body: T,
    ) => ({
      v: 1 as const,
      roomId: f.roomId,
      operationId: crypto.randomUUID(),
      deadline: Date.now() + 55_000,
      ...body,
    });
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        const invite: AuthorityRequest = request({
          action: "allow-email" as const,
          email: guest.email,
          role: "editor" as const,
        });
        const before = fetchSpy.mock.calls.length;
        for (const forbidden of [
          invite,
          request({
            action: "set-link-role" as const,
            linkRole: "editor" as const,
          }),
          request({ action: "end-room" as const }),
          // Only the owner may look at a room that is still initializing.
          request({ action: "get-state" as const }),
        ])
          expect(
            await applyAuthorityEntry(
              a,
              { proof: proof(forbidden, guest), request: forbidden },
              config,
            ),
          ).toMatchObject({ ok: false, error: "forbidden" });
        expect(fetchSpy.mock.calls.length).toBe(before);
        const stateRequest: AuthorityRequest = request({
          action: "get-state" as const,
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(stateRequest), request: stateRequest },
            config,
          ),
        ).toMatchObject({
          ok: true,
          result: { state: "initializing", role: "owner", linkRole: "none" },
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(invite), request: invite },
            config,
          ),
        ).toMatchObject({ ok: true, result: { status: "enforced" } });
        const query: AuthorityRequest = {
          ...request({ action: "query" as const }),
          operationId: invite.operationId,
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(query), request: query },
            config,
          ),
        ).toMatchObject({
          ok: true,
          result: { operationId: invite.operationId, status: "enforced" },
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(query, guest), request: query },
            config,
          ),
        ).toMatchObject({ ok: false });
        // Inviting records no member row; only opening the room does.
        expect(
          state.storage.sql
            .exec("SELECT * FROM authority_members WHERE subject='guest'")
            .toArray(),
        ).toEqual([]);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
