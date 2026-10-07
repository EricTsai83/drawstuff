import {
  env,
  runInDurableObject,
  SELF,
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterCommandSchema,
  type AssetRequest,
  type AssetUploadIntent,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import {
  ASSET_CRYPTO_VERSION,
  MIN_ASSET_CIPHERTEXT_BYTES,
} from "@drawstuff/collaboration/asset";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { RoomAuthority } from "../src/room-authority.ts";
import { AdapterClient } from "../src/adapter-client.ts";
import { applyAssetEntry } from "../src/asset-entry.ts";

const owner: TrustedIdentity = {
  subject: "asset-owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const guest: TrustedIdentity = {
  subject: "asset-guest",
  email: "guest@example.com",
  lifecycleVersion: 1,
};
const config: Env = {
  ...env,
  COLLAB_ADAPTER_URL: "https://adapter.test/api/internal/collaboration/adapter",
};
const fileId = "a".repeat(40);
const checksum = "a".repeat(64);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const roomId = roomIdSchema.parse(`asset-${crypto.randomUUID()}`);
  const envelope = {
    v: 1 as const,
    roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  };
  const intent: AssetUploadIntent = {
    ...envelope,
    kind: "asset-finalize",
    authGeneration: 1,
    authorityEpoch: 1,
    expectedRevision: 0,
    checksum,
    excalidrawFileId: fileId,
    cryptoVersion: ASSET_CRYPTO_VERSION,
    byteLength: MIN_ASSET_CIPHERTEXT_BYTES,
  };
  const asset = {
    excalidrawFileId: fileId,
    cryptoVersion: ASSET_CRYPTO_VERSION,
    byteLength: intent.byteLength,
    url: "https://storage.test/ciphertext",
    utFileKey: "provider-key",
  };
  const proof = (actor = owner) => {
    const iat = Math.floor(Date.now() / 1000);
    return signIdentityProof(
      {
        v: 1,
        aud: "drawstuff-room-identity",
        protocolVersion: 6,
        roomId,
        identity: actor,
        jti: crypto.randomUUID(),
        iat,
        exp: iat + 60,
      },
      config.COLLAB_IDENTITY_SECRET,
    );
  };
  return {
    roomId,
    envelope,
    intent,
    asset,
    proof,
    stub: env.COLLABORATION_ROOM.getByName(roomId),
  };
}
type Fixture = ReturnType<typeof fixture>;
async function initialized(
  f: Fixture,
  fn: (a: RoomAuthority) => Promise<void>,
  ready = false,
) {
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    const a = new RoomAuthority(ctx.storage, f.roomId);
    await a.apply({
      ...f.envelope,
      actor: owner,
      action: "create",
      sceneId: null,
      label: "",
      linkRole: "viewer",
    });
    await a.confirmParent(f.envelope.operationId);
    if (ready) {
      await a.apply({
        ...f.envelope,
        actor: owner,
        operationId: crypto.randomUUID(),
        action: "set-key-check",
        expectedGeneration: 1,
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const manifest = {
        authGeneration: 1,
        revision: 1,
        checksum,
        assetIds: [],
      };
      const complete = {
        ...f.envelope,
        actor: owner,
        operationId: crypto.randomUUID(),
        action: "complete-initialization" as const,
        manifest,
      };
      await a.apply(complete);
      await a.confirmFence(a.state()!.authority_epoch);
      await a.confirmInitialization(complete.operationId, manifest);
      f.intent.authorityEpoch = a.state()!.authority_epoch;
    }
    try {
      await fn(a);
    } finally {
      await ctx.storage.deleteAlarm();
    }
  });
}
function adapter(
  handler?: (
    command: ReturnType<typeof adapterCommandSchema.parse>,
  ) => Promise<Response> | Response,
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${config.COLLAB_ADAPTER_SECRET}`,
      );
      expect(init?.redirect).toBe("manual");
      const command = adapterCommandSchema.parse(
        JSON.parse(jsonBody(init)) as unknown,
      );
      if (command.action === "register")
        return Response.json({
          roomId: command.roomId,
          operationId: command.operationId,
          subject: command.identity.subject,
          lifecycleVersion: command.identity.lifecycleVersion,
        });
      return handler
        ? handler(command)
        : Response.json({ status: "written", revision: 1 });
    });
}
function call(
  a: RoomAuthority,
  f: Fixture,
  request: AssetRequest,
  actor = owner,
) {
  return applyAssetEntry(a, { proof: f.proof(actor), request }, config);
}
const finalize = (
  f: Fixture,
): Extract<AssetRequest, { action: "finalize" }> => ({
  action: "finalize",
  intent: f.intent,
  asset: f.asset,
});
const read = (f: Fixture): AssetRequest => ({
  ...f.envelope,
  action: "read",
  fileIds: [fileId],
});

describe("Room attachment authority", () => {
  it("requires the private gateway capability before routing assets", async () => {
    const f = fixture();
    const response = await SELF.fetch("https://gateway.test/v1/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: f.proof(), request: finalize(f) }),
    });
    expect(response.status).toBe(401);
  });
  it("forwards a verified service request through Gateway to the stable Room RPC", async () => {
    const f = fixture();
    // The gateway fixture intentionally has no adapter URL. Fake only that outbound boundary.
    vi.spyOn(AdapterClient.prototype, "call").mockImplementation(
      async (command, schema) => {
        if (command.action !== "register")
          throw new Error("unexpected-command");
        return schema.parse({
          roomId: command.roomId,
          operationId: command.operationId,
          subject: command.identity.subject,
          lifecycleVersion: command.identity.lifecycleVersion,
        });
      },
    );
    await initialized(f, async () => undefined);
    const response = await SELF.fetch("https://gateway.test/v1/assets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.COLLAB_AUTHORITY_SECRET}`,
      },
      body: JSON.stringify({
        proof: f.proof(),
        request: { action: "prepare", intent: f.intent },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { status: "authorized", authGeneration: 1 },
    });
  });
  it("permits owner presign in initialization without accepting or staging content", async () => {
    const f = fixture();
    const fetch = adapter();
    await initialized(f, async (a) => {
      expect(
        await call(a, f, { action: "prepare", intent: f.intent }),
      ).toMatchObject({
        ok: true,
        result: { status: "authorized", authorityEpoch: 1 },
      });
      expect(a.contentResult(f.intent.operationId)).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
  it("refuses a non-owner during initialization", async () => {
    const f = fixture();
    const fetch = adapter();
    await initialized(f, async (a) => {
      expect(await call(a, f, read(f), guest)).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });
  it("lets a viewer resolve records but refuses presign and finalization", async () => {
    const f = fixture();
    adapter(() =>
      Response.json({ assets: [{ ...f.asset, utFileKey: undefined }] }),
    );
    await initialized(
      f,
      async (a) => {
        expect(await call(a, f, read(f), guest)).toMatchObject({
          ok: true,
          result: { authGeneration: 1, missing: [] },
        });
        expect(
          await call(a, f, { action: "prepare", intent: f.intent }, guest),
        ).toEqual({ ok: false, error: "forbidden" });
        expect(await call(a, f, finalize(f), guest)).toEqual({
          ok: false,
          error: "forbidden",
        });
      },
      true,
    );
  });
  it("binds the provider descriptor once and confirms the initialization manifest with the written receipt", async () => {
    const f = fixture();
    const fetch = adapter();
    await initialized(f, async (a) => {
      expect(await call(a, f, finalize(f))).toEqual({
        ok: true,
        result: { status: "written", revision: 1 },
      });
      expect(await call(a, f, finalize(f))).toMatchObject({
        ok: true,
        result: { status: "written" },
      });
      expect(
        fetch.mock.calls.filter(([, init]) =>
          jsonBody(init).includes('"action":"write"'),
        ),
      ).toHaveLength(1);
      expect(
        await call(a, f, {
          ...finalize(f),
          action: "finalize",
          asset: { ...f.asset, utFileKey: "replacement" },
        }),
      ).toEqual({ ok: false, error: "operation-mismatch" });
      await a.apply({
        ...f.envelope,
        operationId: crypto.randomUUID(),
        actor: owner,
        action: "set-key-check",
        expectedGeneration: 1,
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const manifest = {
        authGeneration: 1,
        revision: 1,
        checksum,
        assetIds: [fileId],
      };
      const complete = {
        ...f.envelope,
        operationId: crypto.randomUUID(),
        actor: owner,
        action: "complete-initialization" as const,
        manifest,
      };
      await a.apply(complete);
      await a.confirmFence(a.state()!.authority_epoch);
      await a.confirmInitialization(complete.operationId, manifest);
      expect(a.state()!.state).toBe("ready");
    });
  });
  it("recovers a lost write response by the original intent after eviction", async () => {
    const f = fixture();
    adapter((command) =>
      command.action === "write"
        ? Promise.reject(new Error("reply-lost"))
        : Response.json({ status: "written", revision: 1 }),
    );
    await initialized(f, async (a) => {
      expect(await call(a, f, finalize(f))).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(a.contentResult(f.intent.operationId)).toEqual({
        status: "pending",
      });
    });
    await evictDurableObject(f.stub);
    await runInDurableObject(f.stub, async (_instance, ctx) => {
      const a = new RoomAuthority(ctx.storage, f.roomId);
      expect(await call(a, f, { action: "query", intent: f.intent })).toEqual({
        ok: true,
        result: { status: "written", revision: 1 },
      });
      await ctx.storage.deleteAlarm();
    });
  });
  it("cancels an accepted descriptor and refuses a late callback replay", async () => {
    const f = fixture();
    adapter((command) =>
      command.action === "write"
        ? Promise.reject(new Error("lost"))
        : Response.json({ status: "cancelled" }),
    );
    await initialized(f, async (a) => {
      await call(a, f, finalize(f));
      expect(await call(a, f, { action: "cancel", intent: f.intent })).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
      expect(await call(a, f, finalize(f))).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
    });
  });
  it("uses the Room clock to certify expired absence and forbids later acceptance", async () => {
    const f = fixture();
    adapter();
    await initialized(f, async (a) => {
      expect(await call(a, f, { action: "query", intent: f.intent })).toEqual({
        ok: true,
        result: { status: "absent", expired: false },
      });
      f.intent.deadline = Date.now() - 1;
      expect(await call(a, f, { action: "query", intent: f.intent })).toEqual({
        ok: true,
        result: { status: "absent", expired: true },
      });
      expect(await call(a, f, finalize(f))).toEqual({
        ok: false,
        error: "expired-operation",
      });
    });
  });
  it("does not leak another actor's receipt or accept a changed file/length/checksum", async () => {
    const f = fixture();
    adapter();
    await initialized(f, async (a) => {
      await call(a, f, finalize(f));
      for (const patch of [
        { checksum: "b".repeat(64) },
        { byteLength: f.intent.byteLength + 1 },
        { excalidrawFileId: "b".repeat(40) },
      ])
        expect(
          await call(a, f, {
            action: "query",
            intent: { ...f.intent, ...patch },
          }),
        ).toEqual({ ok: false, error: "operation-mismatch" });
      // A current viewer can read assets, but cannot query an owner's content result.
    });
    const g = fixture();
    adapter();
    await initialized(
      g,
      async (a) => {
        await call(a, g, finalize(g));
        expect(
          await call(a, g, { action: "query", intent: g.intent }, guest),
        ).toEqual({ ok: false, error: "operation-mismatch" });
      },
      true,
    );
  });
  it("rechecks a revocation after registration and before accepting a callback", async () => {
    const f = fixture();
    await initialized(f, async (a) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const command = adapterCommandSchema.parse(
          JSON.parse(jsonBody(init)) as unknown,
        );
        if (command.action !== "register") throw new Error("unexpected-write");
        await a.apply({
          ...f.envelope,
          operationId: crypto.randomUUID(),
          actor: owner,
          action: "end-room",
        });
        return Response.json({
          roomId: f.roomId,
          operationId: command.operationId,
          subject: owner.subject,
          lifecycleVersion: 1,
        });
      });
      expect(await call(a, f, finalize(f))).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(a.contentResult(f.intent.operationId)).toBeUndefined();
    });
  });
  it("reads the production adapter asset wrapper and derives missing IDs", async () => {
    const f = fixture();
    await initialized(
      f,
      async (a) => {
        adapter(async (command) => {
          if (command.action !== "read-assets")
            throw new Error("unexpected-command");
          return Response.json({
            assets: [{ ...f.asset, utFileKey: undefined }],
          });
        });
        const missing = "b".repeat(40);
        expect(
          await call(a, f, {
            ...f.envelope,
            action: "read",
            fileIds: [fileId, missing],
          }),
        ).toEqual({
          ok: true,
          result: {
            roomId: f.roomId,
            authGeneration: 1,
            assets: [
              {
                excalidrawFileId: fileId,
                cryptoVersion: f.asset.cryptoVersion,
                byteLength: f.asset.byteLength,
                url: f.asset.url,
              },
            ],
            missing: [missing],
          },
        });
      },
      true,
    );
  });
  it("withholds discovered URLs when a generation rotates during storage I/O", async () => {
    const f = fixture();
    await initialized(
      f,
      async (a) => {
        adapter(async (command) => {
          if (command.action !== "read-assets")
            throw new Error("unexpected-command");
          await a.apply({
            ...f.envelope,
            operationId: crypto.randomUUID(),
            actor: owner,
            action: "rotate-generation",
            expectedGeneration: 1,
          });
          return Response.json({
            assets: [{ ...f.asset, utFileKey: undefined }],
          });
        });
        expect(await call(a, f, read(f))).toEqual({
          ok: false,
          error: "generation-mismatch",
        });
      },
      true,
    );
  });
  it("rejects mismatched descriptors and expired/wrong-generation presign before writing", async () => {
    const f = fixture();
    adapter();
    await initialized(f, async (a) => {
      expect(
        await call(a, f, {
          action: "finalize",
          intent: f.intent,
          asset: { ...f.asset, byteLength: f.asset.byteLength + 1 },
        }),
      ).toEqual({ ok: false, error: "operation-mismatch" });
      expect(
        await call(a, f, {
          action: "prepare",
          intent: { ...f.intent, authGeneration: 2 },
        }),
      ).toEqual({ ok: false, error: "generation-mismatch" });
      expect(
        await call(a, f, {
          action: "prepare",
          intent: { ...f.intent, deadline: Date.now() - 1 },
        }),
      ).toEqual({ ok: false, error: "expired-operation" });
      expect(a.contentResult(f.intent.operationId)).toBeUndefined();
    });
  });
  it("refuses unexpected or duplicate provider records before returning capabilities", async () => {
    const f = fixture();
    await initialized(f, async (a) => {
      adapter(() =>
        Response.json({
          assets: [
            { ...f.asset, utFileKey: undefined },
            { ...f.asset, utFileKey: undefined },
          ],
        }),
      );
      expect(await call(a, f, read(f))).toEqual({
        ok: false,
        error: "unavailable",
      });
    });
  });
});

function jsonBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("expected-metadata-only");
  return init.body;
}
