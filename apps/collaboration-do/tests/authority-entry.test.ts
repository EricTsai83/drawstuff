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
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import { RoomAuthority } from "../src/room-authority.ts";
import { applyAuthorityEntry } from "../src/authority-entry.ts";
import { RoomDelivery } from "../src/room-delivery.ts";
import { AdapterClient } from "../src/adapter-client.ts";
const IDENTITY_SECRET = "test-identity-secret-purpose-only-0001";
const SERVICE_SECRET = "test-authority-secret-purpose-only-0001";
const config: Env = {
  ...env,
  COLLAB_ADAPTER_URL: "https://adapter.test/api/internal/collaboration/adapter",
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
      protocolVersion: 6,
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
      const command = adapterCommandSchema.parse(
        JSON.parse(init.body) as unknown,
      );
      if (command.action === "register")
        return Response.json({
          roomId: command.roomId,
          operationId: command.operationId,
          subject: command.identity.subject,
          lifecycleVersion: command.identity.lifecycleVersion,
          ...(command.targetSubject
            ? { targetSubject: command.targetSubject, targetVersion: 2 }
            : {}),
        });
      if (command.action === "create-parent")
        return Response.json({
          roomId: command.roomId,
          createOperationId: command.createOperationId,
        });
      if (command.action === "project") return Response.json({ applied: true });
      if (command.action === "fence")
        return Response.json({ authorityEpoch: command.authorityEpoch });
      throw new Error("unexpected-command");
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
  it("persists owner revocation during adapter failure without granting offline access", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        const grant: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "set-member-role",
          subject: guest.subject,
          role: "editor",
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(grant), request: grant },
            config,
          ),
        ).toMatchObject({ ok: true });
        fetchSpy.mockRejectedValue(new Error("adapter-offline"));
        fetchSpy.mockClear();
        const revoke: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "revoke-member",
          subject: guest.subject,
        };
        expect(
          await applyAuthorityEntry(
            a,
            {
              proof: proof(revoke, { ...guest, lifecycleVersion: 2 }),
              request: revoke,
            },
            config,
          ),
        ).toMatchObject({ ok: false, error: "forbidden" });
        const result = await applyAuthorityEntry(
          a,
          { proof: proof(revoke), request: revoke },
          config,
        );
        expect(result).toMatchObject({
          ok: true,
          result: { status: "pending" },
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(revoke), request: revoke },
            config,
          ),
        ).toEqual(result);
        expect(
          state.storage.sql
            .exec<{ revoked: number }>(
              "SELECT revoked FROM authority_members WHERE subject='guest'",
            )
            .one().revoked,
        ).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(
          await applyAuthorityEntry(
            a,
            {
              proof: proof(grant),
              request: { ...grant, operationId: crypto.randomUUID() },
            },
            config,
          ),
        ).toMatchObject({ ok: false, error: "unavailable" });
        expect(
          state.storage.sql
            .exec<{ revoked: number }>(
              "SELECT revoked FROM authority_members WHERE subject='guest'",
            )
            .one().revoked,
        ).toBe(1);
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
              "x-drawstuff-internal-auth-generation": "1",
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
  it("refuses non-owner commands before target registration and uses the target's trusted version", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const a = new RoomAuthority(state.storage, f.roomId);
        await applyAuthorityEntry(
          a,
          { proof: proof(f.create), request: f.create },
          config,
        );
        const grant: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "set-member-role",
          subject: "guest",
          role: "editor",
        };
        const before = fetchSpy.mock.calls.length;
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(grant, guest), request: grant },
            config,
          ),
        ).toMatchObject({ ok: false, error: "forbidden" });
        expect(fetchSpy.mock.calls.length).toBe(before);
        const keyCheck: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "set-key-check",
          expectedGeneration: 1,
          keyCheck: Array.from({ length: KEYCHECK_CIPHERTEXT_BYTES }, () => 0),
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(keyCheck), request: keyCheck },
            config,
          ),
        ).toMatchObject({ ok: true });
        const stateRequest: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + 55_000,
          action: "get-state",
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(stateRequest), request: stateRequest },
            config,
          ),
        ).toMatchObject({
          ok: true,
          result: {
            state: "initializing",
            authGeneration: 1,
            keyCheck: keyCheck.keyCheck,
          },
        });
        const keyQuery: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: keyCheck.operationId,
          deadline: Date.now() + 55_000,
          action: "query",
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(keyQuery), request: keyQuery },
            config,
          ),
        ).toMatchObject({
          ok: true,
          result: { operationId: keyCheck.operationId },
        });
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(grant), request: grant },
            config,
          ),
        ).toMatchObject({ ok: true, result: { status: "pending" } });
        expect(
          state.storage.sql
            .exec<{ lifecycle_version: number }>(
              "SELECT lifecycle_version FROM authority_members WHERE subject='guest'",
            )
            .one().lifecycle_version,
        ).toBe(2);
        const query: AuthorityRequest = {
          v: 1,
          roomId: f.roomId,
          operationId: grant.operationId,
          deadline: Date.now() + 55_000,
          action: "query",
        };
        expect(
          await applyAuthorityEntry(
            a,
            { proof: proof(query, guest), request: query },
            config,
          ),
        ).toMatchObject({ ok: false });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
