import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  adapterCommandSchema,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import type { RoomKeyRequest } from "@drawstuff/collaboration/key-custody";
import { sealRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { decodeBase64 } from "@drawstuff/collaboration/base64";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { generateRoomKey } from "@drawstuff/collaboration/realtime-crypto";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { RoomAuthority } from "../src/room-authority.ts";
import { applyRoomKeyEntry } from "../src/room-key-entry.ts";

const IDENTITY_SECRET = "test-identity-secret-purpose-only-0001";
const config: Env = {
  ...env,
  COLLAB_ADAPTER_URL: "https://adapter.test/api/internal/collaboration/adapter",
};
const person = (subject: string): TrustedIdentity => ({
  subject,
  email: `${subject}@example.com`,
  lifecycleVersion: 1,
});
const owner = person("owner");

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
        });
      if (command.action === "create-parent")
        return Response.json({
          roomId: command.roomId,
          createOperationId: command.createOperationId,
        });
      if (command.action === "project") return Response.json({ applied: true });
      if (command.action === "fence")
        return Response.json({ authorityEpoch: command.authorityEpoch });
      if (command.action === "cleanup") return Response.json({ cleaned: true });
      throw new Error("unexpected-command");
    });
}

function call(
  authority: RoomAuthority,
  identity: TrustedIdentity,
  request:
    | { action: "get-room-key" }
    | { action: "escrow-room-key"; authGeneration?: number; roomKey: string },
) {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    v: 1,
    roomId: authority.roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
    ...request,
  } as RoomKeyRequest;
  return applyRoomKeyEntry(
    authority,
    {
      proof: signIdentityProof(
        {
          v: 1,
          aud: "drawstuff-room-identity",
          protocolVersion: 6,
          roomId: authority.roomId,
          identity,
          jti: crypto.randomUUID(),
          iat: now,
          exp: now + 60,
        },
        IDENTITY_SECRET,
      ),
      request: full,
    },
    config,
  );
}

/** A ready room sealed with `roomKey`, with a member, a revoked member and an invitation. */
async function readyRoom(
  authority: RoomAuthority,
  storage: DurableObjectStorage,
) {
  const roomKey = generateRoomKey();
  const create = {
    v: 1 as const,
    action: "create" as const,
    operationId: crypto.randomUUID(),
    roomId: authority.roomId,
    actor: owner,
    deadline: Date.now() + 55_000,
    sceneId: null,
    label: "",
    // Anyone signed in may join with the link; that alone must not release the key.
    linkRole: "viewer" as const,
  };
  await authority.apply(create);
  await authority.confirmParent(create.operationId);
  const sealed = decodeBase64(
    await sealRoomKeyCheck({
      roomKey,
      roomId: authority.roomId,
      authGeneration: 1,
    }),
    { maxBytes: 256 },
  );
  if (!sealed.ok) throw new Error("key-check");
  storage.sql.exec(
    "UPDATE authority_room SET state='ready', key_check=?",
    JSON.stringify(Array.from(sealed.bytes)),
  );
  storage.sql.exec(
    "INSERT INTO authority_members(subject,role,revoked,lifecycle_version,email_key,key_eligible) VALUES ('member','editor',0,1,'member@example.com',2),('gone','viewer',1,1,'gone@example.com',2),('linked','viewer',0,1,'linked@example.com',0)",
  );
  storage.sql.exec(
    "INSERT INTO authority_allowlist VALUES ('invited@example.com','invited@example.com','viewer','owner',1,0)",
  );
  return roomKey;
}

const fixture = () => {
  const roomId = roomIdSchema.parse(`key-${crypto.randomUUID()}`);
  return { roomId, stub: env.COLLABORATION_ROOM.getByName(roomId) };
};

describe("Room key custody (plan 19)", () => {
  it("releases a verified key only to the owner, members and allowlisted emails", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const authority = new RoomAuthority(state.storage, f.roomId);
        const roomKey = await readyRoom(authority, state.storage);

        expect(
          await call(authority, owner, { action: "get-room-key" }),
        ).toEqual({
          ok: true,
          result: { status: "absent", roomId: f.roomId, authGeneration: 1 },
        });
        expect(
          await call(authority, owner, {
            action: "escrow-room-key",
            authGeneration: 1,
            roomKey,
          }),
        ).toMatchObject({ ok: true, result: { status: "escrowed" } });
        // Idempotent for the same key.
        expect(
          await call(authority, owner, {
            action: "escrow-room-key",
            authGeneration: 1,
            roomKey,
          }),
        ).toMatchObject({ ok: true, result: { status: "escrowed" } });

        for (const holder of [owner, person("member"), person("invited")])
          expect(
            await call(authority, holder, { action: "get-room-key" }),
          ).toEqual({
            ok: true,
            result: {
              status: "found",
              roomId: f.roomId,
              authGeneration: 1,
              roomKey,
            },
          });
        // The link role and a revoked membership release nothing.
        for (const stranger of [person("stranger"), person("gone")])
          expect(
            await call(authority, stranger, { action: "get-room-key" }),
          ).toEqual({ ok: false, error: "forbidden" });

        // Stored only wrapped.
        const stored = state.storage.sql
          .exec<{ wrapped: string }>("SELECT wrapped FROM authority_room_keys")
          .one().wrapped;
        expect(stored).not.toContain(roomKey);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts only the key the room was sealed with", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const authority = new RoomAuthority(state.storage, f.roomId);
        const roomKey = await readyRoom(authority, state.storage);
        const wrongKey = generateRoomKey();
        expect(
          await call(authority, person("member"), {
            action: "escrow-room-key",
            authGeneration: 1,
            roomKey: wrongKey,
          }),
        ).toEqual({ ok: false, error: "operation-mismatch" });
        expect(
          await call(authority, owner, {
            action: "escrow-room-key",
            authGeneration: 2,
            roomKey,
          }),
        ).toEqual({ ok: false, error: "generation-mismatch" });
        // A member who opened the room with its link backfills custody.
        expect(
          await call(authority, person("member"), {
            action: "escrow-room-key",
            authGeneration: 1,
            roomKey,
          }),
        ).toMatchObject({ ok: true, result: { status: "escrowed" } });
        expect(
          await call(authority, person("stranger"), {
            action: "escrow-room-key",
            authGeneration: 1,
            roomKey,
          }),
        ).toEqual({ ok: false, error: "forbidden" });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stops releasing a key once the link is reset or the room ends", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const authority = new RoomAuthority(state.storage, f.roomId);
        const roomKey = await readyRoom(authority, state.storage);
        await call(authority, owner, {
          action: "escrow-room-key",
          authGeneration: 1,
          roomKey,
        });
        await authority.apply({
          v: 1,
          action: "rotate-generation",
          operationId: crypto.randomUUID(),
          roomId: f.roomId,
          actor: owner,
          deadline: Date.now() + 55_000,
          expectedGeneration: 1,
        });
        expect(authority.custodiedKey(1)).toBeUndefined();
        expect(
          await call(authority, person("member"), { action: "get-room-key" }),
        ).toEqual({ ok: false, error: "forbidden" });

        await authority.apply({
          v: 1,
          action: "end-room",
          operationId: crypto.randomUUID(),
          roomId: f.roomId,
          actor: owner,
          deadline: Date.now() + 55_000,
        });
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM authority_room_keys",
            )
            .one().count,
        ).toBe(0);
        expect(
          await call(authority, owner, { action: "get-room-key" }),
        ).toEqual({ ok: false, error: "forbidden" });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("releases nothing to a member who only joined by link until they prove the key", async () => {
    const f = fixture();
    const fetchSpy = mockAdapter();
    try {
      await runInDurableObject(f.stub, async (_instance, state) => {
        const authority = new RoomAuthority(state.storage, f.roomId);
        const roomKey = await readyRoom(authority, state.storage);
        await call(authority, owner, {
          action: "escrow-room-key",
          authGeneration: 1,
          roomKey,
        });
        // A join needs no key, so membership from the link role alone
        // must not unlock custody.
        expect(
          await call(authority, person("linked"), { action: "get-room-key" }),
        ).toEqual({ ok: false, error: "forbidden" });
        // A wrong key proves nothing.
        expect(
          await call(authority, person("linked"), {
            action: "escrow-room-key",
            roomKey: generateRoomKey(),
          }),
        ).toEqual({ ok: false, error: "operation-mismatch" });
        expect(
          await call(authority, person("linked"), { action: "get-room-key" }),
        ).toEqual({ ok: false, error: "forbidden" });
        // Handing over the sealed key proves possession.
        expect(
          await call(authority, person("linked"), {
            action: "escrow-room-key",
            roomKey,
          }),
        ).toMatchObject({ ok: true, result: { status: "escrowed" } });
        expect(
          await call(authority, person("linked"), { action: "get-room-key" }),
        ).toMatchObject({ ok: true, result: { status: "found", roomKey } });

        // A reset link cuts off link-proven custody, not the owner's grants.
        await authority.apply({
          v: 1,
          action: "rotate-generation",
          operationId: crypto.randomUUID(),
          roomId: f.roomId,
          actor: owner,
          deadline: Date.now() + 55_000,
          expectedGeneration: 1,
        });
        const eligibility = Object.fromEntries(
          state.storage.sql
            .exec<{ subject: string; key_eligible: number }>(
              "SELECT subject,key_eligible FROM authority_members WHERE subject IN ('linked','member')",
            )
            .toArray()
            .map((row) => [row.subject, row.key_eligible]),
        );
        expect(eligibility).toEqual({ linked: 0, member: 2 });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
