import { TRPCClientError } from "@trpc/client";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_LIMITS,
  type ManagementResult,
  authorityStateSchema,
} from "@drawstuff/collaboration/authority";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  AuthorityRoomError,
  authorityEnvelope,
  createAuthorityOperation,
  createAuthorityRoomBackend,
  type AuthorityApi,
} from "@/lib/collab/authority-client";
import {
  ASSET_CRYPTO_VERSION,
  createAssetCryptoCodec,
  decodeCollaborationAssetPayload,
  type CollaborationAssetRecord,
} from "@drawstuff/collaboration/asset";
import type {
  BinaryFileData,
  FileId,
  DataURL,
} from "@drawstuff/excalidraw-adapter/types";
import type { AssetApi } from "@/lib/collab/asset-store";
import { createRoomInitialization } from "@/lib/collab/room-initialization";
import type { SnapshotApi } from "@/lib/collab/snapshot-http";
import { createCollaborationSnapshotStore } from "@/lib/collab/snapshot-store";
import { binarySnapshotBackend } from "./support/binary-snapshot-backend";

const sceneId = "12345678-1234-4234-8234-123456789abc";
function notFound() {
  const error = new TRPCClientError("Not found");
  Object.defineProperty(error, "data", { value: { code: "NOT_FOUND" } });
  return error;
}
function fixture() {
  let state = authorityStateSchema.parse({
    roomId: roomIdSchema.parse("uncreated-room"),
    state: "initializing",
    role: "owner",
    sceneId,
    label: "",
    linkRole: "none",
    authGeneration: 1,
    authRevision: 1,
    authorityEpoch: 1,
    initializationDeadline: Date.now() + AUTHORITY_LIMITS.initializationTtlMs,
    keyCheck: null,
  });
  let storage = binarySnapshotBackend(state.roomId);
  const records = new Map<string, CollaborationAssetRecord>();
  const assetUploads = new Map<string, Uint8Array>();
  const assets: AssetApi = {
    upload: vi.fn<AssetApi["upload"]>(async (input) => {
      assetUploads.set(input.excalidrawFileId, input.ciphertext.slice());
      records.set(input.excalidrawFileId, {
        excalidrawFileId: input.excalidrawFileId,
        cryptoVersion: input.cryptoVersion,
        byteLength: input.ciphertext.byteLength,
        url: "https://storage.test/ciphertext",
      });
    }),
    resolve: vi.fn<AssetApi["resolve"]>(async ({ fileIds }) => ({
      authGeneration: state.authGeneration,
      assets: fileIds.flatMap((id) =>
        records.get(id) ? [records.get(id)!] : [],
      ),
      missing: fileIds.filter((id) => !records.has(id)),
    })),
  };
  const results = new Map<string, ManagementResult>();
  const execute = vi.fn<AuthorityApi["execute"]>(async (request) => {
    if (request.action === "get-state") return { ...state };
    if (request.action === "query") {
      const result = results.get(request.operationId);
      if (!result) throw notFound();
      return result;
    }
    const old = results.get(request.operationId);
    if (old) return old;
    if (request.action === "create") {
      state = { ...state, roomId: request.roomId };
      storage = binarySnapshotBackend(request.roomId);
    } else if (request.action === "rotate-generation") {
      state = {
        ...state,
        state: "initializing",
        authGeneration: request.expectedGeneration + 1,
        authorityEpoch: state.authorityEpoch + 1,
        keyCheck: null,
      };
      storage = binarySnapshotBackend(request.roomId);
      storage.emptyAt(1, state.authGeneration, state.authorityEpoch);
      records.clear();
    } else if (request.action === "set-key-check")
      state = { ...state, keyCheck: request.keyCheck };
    else if (request.action === "complete-initialization") {
      const saved = await storage.api.read({
        ...authorityEnvelope(request.roomId),
        action: "read",
      });
      if (
        !saved.found ||
        request.manifest.revision !== saved.receipt.revision ||
        request.manifest.checksum !== saved.receipt.checksum ||
        request.manifest.assetIds.some((id) => !records.has(id))
      )
        throw new Error("invalid-manifest");
      state = { ...state, state: "ready" };
    } else if (request.action === "end-room")
      state = { ...state, state: "ended" };
    const result: ManagementResult = {
      operationId: request.operationId,
      status: "enforced",
      authRevision: 1,
      authorityEpoch: 1,
      projectionPending: true,
    };
    results.set(request.operationId, result);
    return result;
  });
  const authority: AuthorityApi = {
    execute,
    identity: vi.fn<AuthorityApi["identity"]>(async () => ({
      proof: "identity-only",
      expiresAt: Date.now() + 60_000,
      relayUrl: "wss://gateway.test/socket",
    })),
  };
  const snapshots: SnapshotApi = {
    read: (request) => storage.api.read(request),
    write: (operation, bytes, intent) =>
      storage.api.write(operation, bytes, intent),
    query: (operation) => storage.api.query(operation),
    cancel: (operation) => storage.api.cancel(operation),
  };
  return {
    authority,
    assets,
    records,
    assetUploads,
    execute,
    commit: execute.getMockImplementation()!,
    snapshots,
    results,
    storage: () => storage,
    state: () => state,
    updateState: (update: Partial<typeof state>) => {
      state = { ...state, ...update };
    },
  };
}

describe("product Room authority initialization", () => {
  it("rotates an existing Room through the full encrypted initialization before releasing its replacement key", async () => {
    const f = fixture();
    f.updateState({ state: "ready", authGeneration: 1 });
    const roomId = f.state().roomId;
    const initialization = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      assets: f.assets,
      sceneId: null,
      elements: [],
      files: [],
      rotate: { roomId, expectedGeneration: 1 },
    });
    const result = await initialization.start();
    expect(result.roomId).toBe(roomId);
    expect(result.roomKey).toBeTruthy();
    expect(f.state()).toMatchObject({ state: "ready", authGeneration: 2 });
    expect(f.execute.mock.calls.map(([request]) => request.action)).toContain(
      "rotate-generation",
    );
    expect(
      f.execute.mock.calls.map(([request]) => request.action),
    ).not.toContain("create");
  });
  it("stops a reconnect on a changed generation even while the new generation is still initializing", async () => {
    const f = fixture();
    f.updateState({ state: "initializing", authGeneration: 2 });
    await expect(
      createAuthorityRoomBackend(f.authority).joinRoom({
        roomId: f.state().roomId,
        authGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "generation-mismatch" });
    expect(f.authority.identity).not.toHaveBeenCalled();
    const { classifyJoinFailure } = await import("@/lib/collab/join-failure");
    expect(
      classifyJoinFailure(new AuthorityRoomError("generation-mismatch")),
    ).toEqual({ ok: false, retry: false, failure: "generation-rotated" });
  });
  it("replays only a queried absent intent before its deadline and preserves the original request against caller mutation", async () => {
    const f = fixture();
    const request = {
      ...authorityEnvelope(f.state().roomId),
      action: "set-key-check" as const,
      expectedGeneration: 1,
      keyCheck: Array.from({ length: KEYCHECK_CIPHERTEXT_BYTES }, () => 0),
    };
    const original = structuredClone(request);
    const run = createAuthorityOperation(f.authority, request);
    f.execute.mockRejectedValueOnce(new Error("offline"));
    await expect(run()).rejects.toThrow("offline");
    request.keyCheck[0] = 1;
    await run();
    expect(f.execute.mock.calls.map(([r]) => r.action)).toEqual([
      "set-key-check",
      "query",
      "set-key-check",
    ]);
    expect(f.execute.mock.calls[2]![0]).toEqual(original);
  });
  it("rejects a receipt for another management operation and keeps the original intent for recovery", async () => {
    const f = fixture();
    const request = {
      ...authorityEnvelope(f.state().roomId),
      action: "set-link-role" as const,
      linkRole: "none" as const,
    };
    const run = createAuthorityOperation(f.authority, request);
    f.execute.mockResolvedValueOnce({
      operationId: crypto.randomUUID(),
      status: "enforced",
      authRevision: 1,
      authorityEpoch: 1,
      projectionPending: false,
    });
    await expect(run()).rejects.toThrow("authority-operation-mismatch");
    await run();
    expect(f.execute.mock.calls[1]![0]).toMatchObject({
      action: "query",
      operationId: request.operationId,
    });
  });

  it("stores an explicit encrypted empty snapshot before readiness, even while display projection is pending", async () => {
    const f = fixture();
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements: [],
    });
    const ready = await init.start();
    expect(f.execute.mock.calls.map(([request]) => request.action)).toEqual([
      "create",
      "get-state",
      "set-key-check",
      "complete-initialization",
      "get-state",
    ]);
    expect(f.state().state).toBe("ready");
    const store = await createCollaborationSnapshotStore({
      api: f.snapshots,
      roomId: ready.roomId,
      roomKey: ready.roomKey,
      authGeneration: 1,
    });
    expect(await store.load()).toMatchObject({
      status: "loaded",
      elements: [],
      revision: 1,
    });
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain(ready.roomKey);
  });
  it("recovers a lost create reply with the original operation, room and key; never starts a second room", async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (request) => {
      await f.commit(request);
      throw new Error("lost-reply");
    });
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements: [],
    });
    await expect(init.start()).rejects.toThrow("lost-reply");
    const create = f.execute.mock.calls[0]![0];
    const ready = await init.start();
    expect(ready.roomId).toBe(create.roomId);
    expect(
      f.execute.mock.calls.filter(([request]) => request.action === "create"),
    ).toHaveLength(1);
    expect(f.execute.mock.calls[1]![0]).toMatchObject({
      action: "query",
      operationId: create.operationId,
    });
  });
  it("retains the exact initial capture and encrypted body after a lost snapshot reply", async () => {
    const f = fixture();
    const elements = [
      { id: "first", version: 1, versionNonce: 1, isDeleted: false },
    ];
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements,
    });
    const write = vi.fn<SnapshotApi["write"]>(
      async (operation, bytes, intent) => {
        await f.storage().api.write(operation, bytes, intent);
        throw new Error("lost-snapshot-reply");
      },
    );
    f.snapshots.write = write;
    await expect(init.start()).rejects.toMatchObject({ code: "pending" });
    elements[0]!.version = 2;
    const ready = await init.start();
    expect(write).toHaveBeenCalledTimes(1);
    const store = await createCollaborationSnapshotStore({
      api: f.snapshots,
      ...ready,
      authGeneration: 1,
    });
    expect(await store.load()).toMatchObject({
      status: "loaded",
      elements: [{ id: "first", version: 1 }],
    });
  });
  it("does not share or mint identity credentials until the completion receipt is confirmed", async () => {
    const f = fixture();
    const commit = f.commit;
    f.execute.mockImplementation(async (request) => {
      const result = await commit(request);
      if (request.action === "complete-initialization") {
        const pending = {
          ...f.results.get(request.operationId)!,
          status: "pending" as const,
        };
        f.results.set(request.operationId, pending);
        f.updateState({ state: "initializing" });
        return pending;
      }
      return result;
    });
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements: [],
    });
    await expect(init.start()).rejects.toMatchObject({ code: "pending" });
    const backend = createAuthorityRoomBackend(f.authority);
    await expect(
      backend.joinRoom({ roomId: f.state().roomId }),
    ).rejects.toMatchObject({ code: "initializing" });
    expect(f.authority.identity).not.toHaveBeenCalled();
    const completion = f.execute.mock.calls.find(
      ([r]) => r.action === "complete-initialization",
    )![0];
    f.results.set(completion.operationId, {
      ...f.results.get(completion.operationId)!,
      status: "enforced",
    });
    f.updateState({ state: "ready" });
    await init.start();
    expect(
      f.execute.mock.calls.filter(
        ([r]) => r.action === "complete-initialization",
      ),
    ).toHaveLength(1);
  });
  it("refuses image initialization before allocating a Room or saving a partial snapshot", () => {
    const f = fixture();
    expect(() =>
      createRoomInitialization({
        authority: f.authority,
        snapshots: f.snapshots,
        sceneId,
        elements: [
          {
            id: "image",
            type: "image",
            fileId: "file-1",
            version: 1,
            versionNonce: 1,
            isDeleted: false,
          },
        ],
      }),
    ).toThrow(AuthorityRoomError);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.storage().write).not.toHaveBeenCalled();
  });

  it("initializes an encrypted image and includes it in the ready manifest only after finalization", async () => {
    const f = fixture();
    const file = initialFile();
    const initialization = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      assets: f.assets,
      sceneId,
      elements: [initialImage()],
      files: [file],
    });
    file.dataURL = "data:image/png;base64,AAAA" as DataURL;
    const ready = await initialization.start();
    expect(f.state().state).toBe("ready");
    const complete = f.execute.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "complete-initialization");
    expect(complete).toMatchObject({
      manifest: { assetIds: [initialFile().id] },
    });
    const codec = await createAssetCryptoCodec({
      roomId: ready.roomId,
      roomKey: ready.roomKey,
      authGeneration: 1,
    });
    const opened = await codec.open({
      excalidrawFileId: initialFile().id,
      ciphertext: f.assetUploads.get(initialFile().id)!,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreadable-upload");
    expect(
      decodeCollaborationAssetPayload(opened.plaintext, {
        roomId: ready.roomId,
        excalidrawFileId: initialFile().id,
      }),
    ).toMatchObject({ ok: true, payload: { dataUrl: initialFile().dataURL } });
    expect(f.storage().write).toHaveBeenCalledTimes(1);
  });

  it("retains the same Room/key and withholds its snapshot/manifest while an attachment is missing", async () => {
    const f = fixture();
    const original = f.assets.upload;
    f.assets.upload = vi.fn(async () => {
      throw new Error("upload-unknown");
    });
    const initialization = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      assets: f.assets,
      sceneId,
      elements: [initialImage()],
      files: [initialFile()],
    });
    await expect(initialization.start()).rejects.toMatchObject({
      code: "pending",
    });
    expect(f.storage().write).not.toHaveBeenCalled();
    expect(
      f.execute.mock.calls.some(
        ([request]) => request.action === "complete-initialization",
      ),
    ).toBe(false);
    // The provider callback and Room recovery eventually finalize the original ciphertext.
    f.records.set(initialFile().id, {
      excalidrawFileId: initialFile().id,
      cryptoVersion: ASSET_CRYPTO_VERSION,
      byteLength: 32,
      url: "https://storage.test/ciphertext",
    });
    const ready = await initialization.start();
    expect(ready.roomId).toBe(f.state().roomId);
    expect(
      f.execute.mock.calls.filter(([request]) => request.action === "create"),
    ).toHaveLength(1);
    expect(
      f.execute.mock.calls.filter(
        ([request]) => request.action === "set-key-check",
      ),
    ).toHaveLength(1);
    expect(original).not.toHaveBeenCalled();
  });

  it("refuses incomplete or unsupported source image bytes before creating a Room", () => {
    const f = fixture();
    for (const files of [
      [],
      [{ ...initialFile(), dataURL: "not-an-image" as DataURL }],
    ])
      expect(() =>
        createRoomInitialization({
          authority: f.authority,
          snapshots: f.snapshots,
          assets: f.assets,
          sceneId,
          elements: [initialImage()],
          files,
        }),
      ).toThrow(AuthorityRoomError);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("stops after disposal before a late creation reply can upload images or set a key check", async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.execute.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return f.commit(request);
    });
    const initialization = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      assets: f.assets,
      sceneId,
      elements: [initialImage()],
      files: [initialFile()],
    });
    const starting = initialization.start();
    await vi.waitFor(() => expect(finish).toBeDefined());
    initialization.dispose();
    finish!();
    await expect(starting).rejects.toMatchObject({ code: "cancelled" });
    expect(f.assets.upload).not.toHaveBeenCalled();
    expect(f.storage().write).not.toHaveBeenCalled();
  });

  it("keeps querying its pending end intent even after local Room state is ended, until the fence is confirmed", async () => {
    const f = fixture();
    f.snapshots.write = vi
      .fn<SnapshotApi["write"]>()
      .mockResolvedValue({ status: "pending" });
    f.execute.mockImplementation(async (request) => {
      const result = await f.commit(request);
      if (request.action === "end-room") {
        const pending = {
          ...f.results.get(request.operationId)!,
          status: "pending" as const,
        };
        f.results.set(request.operationId, pending);
        return pending;
      }
      return result;
    });
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements: [],
    });
    await expect(init.start()).rejects.toMatchObject({ code: "pending" });
    await expect(init.cancel()).rejects.toMatchObject({ code: "pending" });
    expect(f.state().state).toBe("ended");
    await expect(init.cancel()).rejects.toMatchObject({ code: "pending" });
    const end = f.execute.mock.calls.find(([r]) => r.action === "end-room")![0];
    f.results.set(end.operationId, {
      ...f.results.get(end.operationId)!,
      status: "enforced",
    });
    await init.cancel();
    expect(
      f.execute.mock.calls.filter(([r]) => r.action === "end-room"),
    ).toHaveLength(1);
    expect(
      f.execute.mock.calls.filter(
        ([r]) => r.action === "query" && r.operationId === end.operationId,
      ),
    ).toHaveLength(2);
  });
  it("ends an abandoned initializing Room before releasing the local attempt, and never resumes it", async () => {
    const f = fixture();
    f.snapshots.write = vi
      .fn<SnapshotApi["write"]>()
      .mockResolvedValue({ status: "pending" });
    const init = createRoomInitialization({
      authority: f.authority,
      snapshots: f.snapshots,
      sceneId,
      elements: [],
    });
    await expect(init.start()).rejects.toMatchObject({ code: "pending" });
    await init.cancel();
    expect(f.state().state).toBe("ended");
    await expect(init.start()).rejects.toMatchObject({ code: "cancelled" });
  });
  it("uses a fresh identity-only proof after a live Room state check, with no client-selected role", async () => {
    const f = fixture();
    f.updateState({ state: "ready", role: "viewer" });
    const joined = await createAuthorityRoomBackend(f.authority).joinRoom({
      roomId: f.state().roomId,
    });
    expect(joined).toMatchObject({
      token: "identity-only",
      role: "viewer",
      authGeneration: 1,
    });
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ action: "get-state" });
    expect(f.authority.identity).toHaveBeenCalledWith({
      roomId: f.state().roomId,
    });
  });
  it("queries after the original mutation deadline with a fresh query deadline, without replaying the expired mutation", async () => {
    const f = fixture();
    const request = {
      ...authorityEnvelope(f.state().roomId),
      action: "set-link-role" as const,
      linkRole: "none" as const,
    };
    const run = createAuthorityOperation(f.authority, request);
    f.execute.mockRejectedValueOnce(new Error("offline"));
    await expect(run()).rejects.toThrow("offline");
    const now = vi.spyOn(Date, "now").mockReturnValue(request.deadline + 1);
    try {
      await expect(run()).rejects.toMatchObject({ code: "expired-operation" });
      expect(f.execute.mock.calls).toHaveLength(2);
      expect(f.execute.mock.calls[1]![0]).toMatchObject({
        action: "query",
        operationId: request.operationId,
        deadline: request.deadline + 1 + AUTHORITY_LIMITS.operationTtlMs,
      });
    } finally {
      now.mockRestore();
    }
  });
});

function initialFile(): BinaryFileData {
  return {
    id: "a".repeat(40) as FileId,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,AAECAwQFBg==" as DataURL,
    created: 1,
  };
}
function initialImage() {
  return {
    id: "initial-image",
    type: "image",
    fileId: initialFile().id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
  };
}
