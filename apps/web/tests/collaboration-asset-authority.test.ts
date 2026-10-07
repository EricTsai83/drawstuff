// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("server-only", () => ({}));
const config = vi.hoisted(() => ({
  COLLAB_IDENTITY_SECRET: "identity-proof-purpose-only-test-secret",
  COLLAB_AUTHORITY_SECRET: "gateway-proof-purpose-only-test-secret",
  COLLAB_CONTROL_URL: "https://gateway.test",
  COLLAB_ROOMS_DISABLED: "off",
}));
vi.mock("@/env", () => ({ env: config }));
vi.mock("@/server/rate-limit/collaboration", () => ({
  enforceCollaborationRateLimit: vi.fn(),
  rateLimitMetadataOf: () => null,
}));
import {
  assetGatewayRequestSchema,
  contentOperationSchema,
  type AssetUploadIntent,
} from "@drawstuff/collaboration/authority";
import {
  MIN_ASSET_CIPHERTEXT_BYTES,
  ASSET_CRYPTO_VERSION,
} from "@drawstuff/collaboration/asset";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import {
  prepareAuthorityAssetUpload,
  finalizeAuthorityAssetUpload,
} from "@/server/collab/asset-authority";
import {
  executeStorageOperation,
  queueAuthorityAssetOrphan,
} from "@/server/collab/authority-storage";
import { callAssetGateway } from "@/server/collab/asset-gateway";
import { collaborationAssetRouter } from "@/server/api/routers/collaboration-asset";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";
import type { Database } from "@/server/collab/rooms";
import { openTestDatabase } from "./support/pglite-db";
import { adapterFixture } from "./support/authority-adapter-fixtures";
import * as schema from "@/server/db/schema";
import { testTrpcContext } from "./support/trpc-caller";
const testDb = openTestDatabase();
const db = testDb as unknown as Database;
afterEach(() => {
  vi.restoreAllMocks();
  config.COLLAB_ROOMS_DISABLED = "off";
});
async function fixture() {
  const f = await adapterFixture(db);
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.id, f.owner));
  const sessionId = `session-${f.owner}`;
  await db.insert(schema.session).values({
    id: sessionId,
    userId: f.owner,
    token: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 120_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const base = f.operation({ kind: "asset-finalize" });
  const { actor, asset, ...envelope } = base;
  void asset;
  const intent: AssetUploadIntent = {
    ...envelope,
    kind: "asset-finalize",
    expectedRevision: 0,
    excalidrawFileId: "a".repeat(40),
    cryptoVersion: ASSET_CRYPTO_VERSION,
    byteLength: MIN_ASSET_CIPHERTEXT_BYTES,
  };
  const file = {
    key: `provider-${crypto.randomUUID()}`,
    ufsUrl: "https://storage.test/ciphertext",
    size: intent.byteLength,
  };
  const metadata = { intent, actor, sessionId };
  const operation = contentOperationSchema.parse({
    ...base,
    asset: {
      excalidrawFileId: intent.excalidrawFileId,
      cryptoVersion: intent.cryptoVersion,
      byteLength: file.size,
      url: file.ufsUrl,
      utFileKey: file.key,
    },
  });
  const gateway = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${config.COLLAB_AUTHORITY_SECRET}`,
      );
      const input = assetGatewayRequestSchema.parse(
        JSON.parse(jsonBody(init)) as unknown,
      );
      const proof = verifyIdentityProof({
        token: input.proof,
        secret: config.COLLAB_IDENTITY_SECRET,
        expectedRoomId: f.roomId,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      expect(proof.ok).toBe(true);
      if (input.request.action === "read")
        return Response.json({
          ok: true,
          result: {
            roomId: f.roomId,
            authGeneration: 1,
            assets: [],
            missing: input.request.fileIds,
          },
        });
      return Response.json({
        ok: true,
        result: { status: "authorized", authGeneration: 1, authorityEpoch: 1 },
      });
    });
  return {
    ...f,
    intent,
    file,
    metadata,
    operation,
    gateway,
    account: { subject: f.owner, sessionId },
    caller: collaborationAssetRouter.createCaller(
      testTrpcContext(testDb, f.owner),
    ),
  };
}
describe("verified attachment server path", () => {
  it("issues presign metadata from the live account/session and Room even when DB role projection disagrees", async () => {
    const f = await fixture();
    await db
      .update(schema.collaborationRoom)
      .set({ status: "ended" })
      .where(eq(schema.collaborationRoom.roomId, f.roomId));
    expect(await prepareAuthorityAssetUpload(db, f.account, f.intent)).toEqual(
      f.metadata,
    );
    expect(f.gateway).toHaveBeenCalledTimes(1);
  });
  it("sends download discovery to Room rather than consulting projected roles", async () => {
    const f = await fixture();
    await expect(
      f.caller.resolve({
        roomId: f.roomId,
        fileIds: [f.intent.excalidrawFileId],
      }),
    ).resolves.toMatchObject({
      assets: [],
      missing: [f.intent.excalidrawFileId],
    });
    expect(enforceCollaborationRateLimit).toHaveBeenCalledWith({
      operation: "asset-resolve",
      identifier: f.owner,
    });
  });
  it("blocks caller-supplied descriptors/actors and anonymous requests before reaching the gateway", async () => {
    const f = await fixture();
    await expect(
      f.caller.execute({
        action: "finalize",
        intent: f.intent,
        asset: f.operation.asset,
      } as unknown as Parameters<typeof f.caller.execute>[0]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.caller.execute({
        action: "query",
        intent: { ...f.intent, actor: f.metadata.actor },
      } as Parameters<typeof f.caller.execute>[0]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      collaborationAssetRouter
        .createCaller(testTrpcContext(testDb, null))
        .resolve({ roomId: f.roomId, fileIds: [f.intent.excalidrawFileId] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.gateway).not.toHaveBeenCalled();
  });
  it("binds the actual provider descriptor and returns a sanitized written receipt", async () => {
    const f = await fixture();
    f.gateway.mockImplementation(async (_url, init) => {
      const { request } = assetGatewayRequestSchema.parse(
        JSON.parse(jsonBody(init)) as unknown,
      );
      expect(request).toMatchObject({
        action: "finalize",
        intent: f.intent,
        asset: f.operation.asset,
      });
      return Response.json({
        ok: true,
        result: await executeStorageOperation(db, "write", f.operation),
      });
    });
    expect(await finalizeAuthorityAssetUpload(db, f.metadata, f.file)).toEqual({
      status: "written",
      revision: 1,
    });
    expect(
      await db.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, f.file.key),
      }),
    ).toBeUndefined();
  });
  it("never queues a referenced object after a committed write loses its reply", async () => {
    const f = await fixture();
    f.gateway.mockImplementation(async () => {
      await executeStorageOperation(db, "write", f.operation);
      throw new Error("lost");
    });
    await expect(
      finalizeAuthorityAssetUpload(db, f.metadata, f.file),
    ).rejects.toThrow("asset-finalization-unknown");
    expect(
      await db.query.collaborationAsset.findFirst({
        where: eq(schema.collaborationAsset.utFileKey, f.file.key),
      }),
    ).toBeDefined();
    expect(
      await db.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, f.file.key),
      }),
    ).toBeUndefined();
  });
  it("queues an unknown unreferenced object and forbids later adoption", async () => {
    const f = await fixture();
    f.gateway.mockRejectedValue(new Error("never-accepted"));
    await expect(
      finalizeAuthorityAssetUpload(db, f.metadata, f.file),
    ).rejects.toThrow();
    expect(
      await db.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, f.file.key),
      }),
    ).toBeDefined();
    expect(await executeStorageOperation(db, "write", f.operation)).toEqual({
      status: "refused",
    });
    await queueAuthorityAssetOrphan(db, f.file.key, f.roomId);
    expect(
      await db
        .select()
        .from(schema.deferredFileCleanup)
        .where(eq(schema.deferredFileCleanup.utFileKey, f.file.key)),
    ).toHaveLength(1);
  });
  it("retains accepted pending callbacks for Room recovery without scheduling object deletion", async () => {
    const f = await fixture();
    f.gateway.mockResolvedValue(
      Response.json({ ok: true, result: { status: "pending" } }),
    );
    expect(await finalizeAuthorityAssetUpload(db, f.metadata, f.file)).toEqual({
      status: "pending",
    });
    expect(
      await db.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, f.file.key),
      }),
    ).toBeUndefined();
  });
  it("refuses an actual ciphertext length mismatch before contacting Room and queues it", async () => {
    const f = await fixture();
    await expect(
      finalizeAuthorityAssetUpload(db, f.metadata, {
        ...f.file,
        size: f.file.size + 1,
      }),
    ).rejects.toThrow();
    expect(f.gateway).not.toHaveBeenCalled();
    expect(
      await db.query.deferredFileCleanup.findFirst({
        where: eq(schema.deferredFileCleanup.utFileKey, f.file.key),
      }),
    ).toBeDefined();
  });
  it.each(["session", "email", "lifecycle"] as const)(
    "rechecks the live %s before accepting the callback",
    async (change) => {
      const f = await fixture();
      await prepareAuthorityAssetUpload(db, f.account, f.intent);
      f.gateway.mockClear();
      if (change === "session")
        await db
          .delete(schema.session)
          .where(eq(schema.session.id, f.metadata.sessionId));
      if (change === "email")
        await db
          .update(schema.user)
          .set({ email: "changed@example.com" })
          .where(eq(schema.user.id, f.owner));
      if (change === "lifecycle")
        await db
          .update(schema.collaborationLifecycleSubject)
          .set({ version: 2 })
          .where(
            and(
              eq(schema.collaborationLifecycleSubject.kind, "account"),
              eq(schema.collaborationLifecycleSubject.subject, f.owner),
            ),
          );
      await expect(
        finalizeAuthorityAssetUpload(db, f.metadata, f.file),
      ).rejects.toThrow();
      expect(f.gateway).not.toHaveBeenCalled();
    },
  );
  it("sanitizes cleanup driver failures before the provider SDK can log object capabilities", async () => {
    const f = await fixture();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(
      new Error(`SQL params include ${f.file.key}`),
    );
    const failure: unknown = await finalizeAuthorityAssetUpload(
      db,
      f.metadata,
      { ...f.file, size: f.file.size + 1 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected-error");
    expect(failure.message).toBe("asset-cleanup-unconfirmed");
    expect(failure.message).not.toContain(f.file.key);
    expect(failure.cause).toBeUndefined();
  });

  it("honors the kill switch before identity issuance", async () => {
    const f = await fixture();
    config.COLLAB_ROOMS_DISABLED = "on";
    await expect(
      prepareAuthorityAssetUpload(db, f.account, f.intent),
    ).rejects.toThrow();
    expect(f.gateway).not.toHaveBeenCalled();
  });
  it("rejects oversized/malformed responses and unexpected result kinds", async () => {
    const f = await fixture();
    for (const response of [
      new Response("x".repeat(65_537), {
        headers: { "content-type": "application/json" },
      }),
      Response.json({ ok: true, result: { status: "written", revision: 0 } }),
      Response.json({ ok: true, result: { status: "written", revision: 1 } }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      await expect(
        callAssetGateway(
          {
            url: config.COLLAB_CONTROL_URL,
            secret: config.COLLAB_AUTHORITY_SECRET,
          },
          "proof",
          {
            action: "read",
            v: 1,
            roomId: f.roomId,
            operationId: crypto.randomUUID(),
            deadline: Date.now() + 55_000,
            fileIds: [f.intent.excalidrawFileId],
          },
          fetch,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    }
  });
});

function jsonBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("expected-metadata-only");
  return init.body;
}
