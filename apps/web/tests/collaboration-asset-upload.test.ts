import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_ASSET_CIPHERTEXT_BYTES,
  ASSET_CRYPTO_VERSION,
} from "@drawstuff/collaboration/asset";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  createAuthorityAssetApi,
  AssetUploadPendingError,
} from "@/lib/collab/asset-upload";
import type { AuthorityApi } from "@/lib/collab/authority-client";
import type { AssetApi } from "@/lib/collab/asset-store";
import type {
  AssetClientRequest,
  AssetUploadIntent,
} from "@drawstuff/collaboration/authority";

const roomId = roomIdSchema.parse("asset-browser-room");
function fixture() {
  const state = {
    roomId,
    state: "initializing",
    role: "owner",
    sceneId: null,
    label: "",
    linkRole: "none",
    authGeneration: 1,
    authRevision: 1,
    authorityEpoch: 3,
    initializationDeadline: Date.now() + 900_000,
    keyCheck: null,
  };
  const authority: AuthorityApi = {
    execute: vi.fn(async () => state),
    identity: vi.fn(),
  };
  const execute = vi.fn<
    (request: AssetClientRequest, signal: AbortSignal) => Promise<unknown>
  >(async () => ({ status: "pending" }));
  const upload = vi.fn<
    (
      intent: AssetUploadIntent,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) => Promise<unknown>
  >(async () => ({ status: "written", revision: 1 }));
  const resolve: AssetApi["resolve"] = vi.fn();
  const api = createAuthorityAssetApi({ authority, execute, upload, resolve });
  const input: Parameters<AssetApi["upload"]>[0] = {
    roomId,
    authGeneration: 1,
    excalidrawFileId: "a".repeat(40),
    cryptoVersion: ASSET_CRYPTO_VERSION,
    ciphertext: new Uint8Array(MIN_ASSET_CIPHERTEXT_BYTES).fill(1),
    signal: new AbortController().signal,
  };
  return { state, authority, execute, upload, api, input };
}
afterEach(() => vi.restoreAllMocks());
describe("immutable browser attachment uploads", () => {
  it("binds opaque length/checksum to the Room epoch and requires a written callback receipt", async () => {
    const f = fixture();
    await f.api.upload(f.input);
    expect(f.upload).toHaveBeenCalledTimes(1);
    const intent = f.upload.mock.calls[0]![0];
    expect(intent).toMatchObject({
      authGeneration: 1,
      authorityEpoch: 3,
      expectedRevision: 0,
      kind: "asset-finalize",
      excalidrawFileId: f.input.excalidrawFileId,
      byteLength: f.input.ciphertext.byteLength,
    });
    expect(intent.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(intent).not.toHaveProperty("actor");
    expect(intent).not.toHaveProperty("asset");
  });
  it("recovers lost callback responses without reuploading changed ciphertext", async () => {
    const f = fixture();
    f.upload.mockRejectedValue(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({ status: "written", revision: 1 });
    await f.api.upload({
      ...f.input,
      ciphertext: new Uint8Array(f.input.ciphertext.length).fill(2),
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]![0]).toEqual({
      action: "query",
      intent: f.upload.mock.calls[0]![0],
    });
  });
  it("keeps pending receipt queries outside the provider upload budget", async () => {
    const f = fixture();
    f.upload.mockResolvedValue({ status: "pending" });
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
        AssetUploadPendingError,
      );
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(4);
  });
  it("queries an unknown provider callback without uploading a replacement object", async () => {
    const f = fixture();
    f.upload.mockResolvedValue({ status: "unknown" });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({ status: "written", revision: 1 });
    await f.api.upload(f.input);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]![0]).toEqual({
      action: "query",
      intent: f.upload.mock.calls[0]![0],
    });
  });
  it("does not treat malformed callback/query responses as confirmation", async () => {
    const f = fixture();
    f.upload.mockResolvedValue({ uploadedBy: "legacy-writer" });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({
      status: "authorized",
      authGeneration: 1,
      authorityEpoch: 3,
    });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({ status: "written", revision: 0 });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it("keeps an absent intent pending until Room certifies expiry, regardless of the browser clock", async () => {
    const f = fixture();
    f.upload.mockRejectedValue(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    f.execute.mockResolvedValue({ status: "absent", expired: false });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it("permits a fresh intent only after expired absence certified by Room", async () => {
    const f = fixture();
    f.upload.mockRejectedValueOnce(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({ status: "absent", expired: true });
    await f.api.upload(f.input);
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(f.upload.mock.calls[1]![0].operationId).not.toBe(
      f.upload.mock.calls[0]![0].operationId,
    );
  });
  it("fences a pending descriptor after its deadline before retrying an upload", async () => {
    const f = fixture();
    f.upload.mockRejectedValueOnce(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 70_000);
    f.execute
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "cancelled" });
    await f.api.upload(f.input);
    expect(f.execute.mock.calls.map(([request]) => request.action)).toEqual([
      "query",
      "cancel",
    ]);
    expect(f.upload).toHaveBeenCalledTimes(2);
  });
  it("adopts a written cancellation race and never starts a replacement object", async () => {
    const f = fixture();
    f.upload.mockRejectedValueOnce(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 70_000);
    f.execute
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "written", revision: 1 });
    await f.api.upload(f.input);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it("never replaces an unknown cancellation", async () => {
    const f = fixture();
    f.upload.mockRejectedValue(new Error("lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 70_000);
    f.execute
      .mockResolvedValueOnce({ status: "pending" })
      .mockRejectedValueOnce(new Error("cancel-lost"));
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent local uploads of one file before presign", async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.upload.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "written", revision: 1 };
    });
    const first = f.api.upload(f.input);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    finish!();
    await first;
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it("caps provider attempts at three while preserving recovery of the last unknown operation", async () => {
    const f = fixture();
    f.upload.mockRejectedValue(new Error("lost"));
    f.execute.mockResolvedValue({ status: "absent", expired: true });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
        AssetUploadPendingError,
      );
    f.execute.mockResolvedValue({ status: "pending" });
    await expect(f.api.upload(f.input)).rejects.toBeInstanceOf(
      AssetUploadPendingError,
    );
    f.execute.mockResolvedValue({ status: "written", revision: 1 });
    await f.api.upload(f.input);
    expect(f.upload).toHaveBeenCalledTimes(3);
    await expect(f.api.upload(f.input)).rejects.toThrow("budget-exhausted");
    expect(f.upload).toHaveBeenCalledTimes(3);
  });
  it("keeps a publisher retrying pending receipts without declaring its image unavailable", async () => {
    const { createCollaborationAssetStore } =
      await import("@/lib/collab/asset-store");
    const { generateRoomKey } =
      await import("@drawstuff/collaboration/realtime-crypto");
    const f = fixture();
    f.upload.mockRejectedValue(new Error("lost"));
    let at = 0;
    const unavailable = vi.fn();
    const store = await createCollaborationAssetStore({
      api: f.api,
      roomId,
      roomKey: generateRoomKey(),
      authGeneration: 1,
      now: () => at,
      onAssetsResolved: vi.fn(),
      onAssetsUnavailable: unavailable,
    });
    const file = {
      id: f.input.excalidrawFileId,
      dataURL: "data:image/png;base64,AAECAwQFBg==",
      mimeType: "image/png",
      created: 1,
    } as BinaryFileData;
    for (let attempt = 0; attempt < 5; attempt++) {
      await store.publish([file]);
      at += 10_000;
    }
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(unavailable).not.toHaveBeenCalled();
    store.destroy();
  });
  it("rejects a changed generation and an aborted transfer before presign", async () => {
    const f = fixture();
    f.state.authGeneration = 2;
    await expect(f.api.upload(f.input)).rejects.toMatchObject({
      code: "generation-mismatch",
    });
    await expect(
      f.api.upload({ ...f.input, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(f.upload).not.toHaveBeenCalled();
  });
});
