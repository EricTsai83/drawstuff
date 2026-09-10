// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaveSceneResult } from "@/server/actions";

import { APP_ERROR } from "@/lib/errors";
import { en } from "@/lib/i18n/en";
import {
  hook,
  mocks,
  mountProbe,
  onSceneNotFound,
  rerender,
  unmountProbe,
  upload,
} from "./support/cloud-upload-harness";

const rejected = (
  error: string,
  extra: Record<string, unknown> = {},
): SaveSceneResult => ({ ok: false, error, ...extra }) as SaveSceneResult;

/** Uploads resolve per file so a test can fail exactly one of them. */
const uploadKeyed = () =>
  mocks.startAssetUpload.mockImplementation(
    (_files: File[], input: { excalidrawFileId: string }) =>
      Promise.resolve([{ key: `key-${input.excalidrawFileId}` }]),
  );

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.assign(mocks.session, {
    currentSceneId: "scene-1",
    currentWorkspaceId: "ws-1",
    lastSyncedRevision: 3,
  });
  mocks.getCurrentSceneSnapshot.mockReturnValue({
    elements: [],
    appState: { name: "Scene" },
    files: {},
  });
  mocks.readSceneAssetFileIds.mockResolvedValue({ ok: true, fileIds: [] });
  mocks.prepareSceneDataForExport.mockResolvedValue({
    compressedSceneData: new Uint8Array([1]),
    compressedFilesData: [
      { id: "file-1", buffer: new Uint8Array([1]) },
      { id: "file-2", buffer: new Uint8Array([2]) },
    ],
    encryptionKey: null,
  });
  mocks.exportSceneThumbnail.mockResolvedValue(new Blob(["png"]));
  uploadKeyed();
  mocks.startThumbnailUpload.mockResolvedValue([{ key: "thumb" }]);
  mocks.saveScene.mockResolvedValue({
    ok: true,
    data: { id: "scene-1", revision: 4, updatedAt: "", isPublished: false },
  } satisfies SaveSceneResult);
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "scene-new", revision: 0, updatedAt: "" },
  });
  mocks.cleanupSceneAssetUploads.mockResolvedValue({ success: true });
  mocks.deleteScene.mockResolvedValue(undefined);

  mountProbe();
});

afterEach(unmountProbe);

describe("useCloudUpload failure paths", () => {
  it("refuses without a scene snapshot", async () => {
    mocks.getCurrentSceneSnapshot.mockReturnValue(null);
    await expect(upload()).resolves.toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.sceneData"],
    );
    expect(hook().status).toBe("error");
    expect(mocks.saveScene).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<typeof mocks.session>, keyof typeof en]>([
    [
      "update mode without a scene",
      { currentSceneId: undefined },
      "app.cloudUpload.toast.error.noSceneToUpdate",
    ],
    [
      "no workspace",
      { currentWorkspaceId: undefined },
      "toast.workspace.required",
    ],
    // `getSceneMeta` resolves to nothing by default, so the recovery finds no revision.
    [
      "revision unknown and unrecoverable",
      { lastSyncedRevision: undefined },
      "toast.scene.versionCheckFailed",
    ],
  ])(
    "refuses early with %s and touches no server action",
    async (_label, sessionPatch, key) => {
      Object.assign(mocks.session, sessionPatch);
      rerender();
      await expect(upload({ mode: "update" })).resolves.toBe(false);
      expect(mocks.toastError).toHaveBeenCalledWith(en[key]);
      expect(hook().status).toBe("error");
      expect(mocks.saveScene).not.toHaveBeenCalled();
      expect(mocks.startAssetUpload).not.toHaveBeenCalled();
      expect(mocks.createSceneDraft).not.toHaveBeenCalled();
    },
  );

  it("cleans up the uploaded asset and rolls back the draft when the save throws", async () => {
    mocks.saveScene.mockRejectedValue(new Error("db down"));
    await expect(upload({ mode: "create" })).resolves.toBe(false);

    expect(mocks.session.markCurrentSceneDirty).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupSceneAssetUploads).toHaveBeenCalledWith({
      sceneId: "scene-new",
      fileKeys: ["key-file-1", "key-file-2"],
    });
    expect(mocks.deleteScene).toHaveBeenCalledWith({ id: "scene-new" });
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.upload"],
    );
    expect(console.error).toHaveBeenCalledWith(
      "Failed to save scene record to DB:",
      expect.any(Error),
    );
    expect(hook().status).toBe("error");
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
  });

  it("does not delete an existing scene when its save is rejected", async () => {
    mocks.saveScene.mockResolvedValue(
      rejected(APP_ERROR.VALIDATION_FAILED, { message: "bad" }),
    );
    await expect(upload()).resolves.toBe(false);
    expect(mocks.cleanupSceneAssetUploads).toHaveBeenCalledWith({
      sceneId: "scene-1",
      fileKeys: ["key-file-1", "key-file-2"],
    });
    expect(mocks.deleteScene).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.upload"],
    );
  });

  it("stops before the save when an asset upload fails, cleaning up the ones that landed", async () => {
    mocks.startAssetUpload.mockImplementation(
      (_files: File[], input: { excalidrawFileId: string }) =>
        input.excalidrawFileId === "file-2"
          ? Promise.reject(new Error("upload refused"))
          : Promise.resolve([{ key: "key-file-1" }]),
    );
    await expect(upload()).resolves.toBe(false);
    expect(mocks.saveScene).not.toHaveBeenCalled();
    expect(mocks.cleanupSceneAssetUploads).toHaveBeenCalledWith({
      sceneId: "scene-1",
      fileKeys: ["key-file-1"],
    });
    expect(mocks.session.markCurrentSceneDirty).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.upload"],
    );
  });

  it("treats an upload returning no key as a failed upload", async () => {
    mocks.startAssetUpload.mockResolvedValue([{ serverData: {} }]);
    await expect(upload()).resolves.toBe(false);
    expect(mocks.saveScene).not.toHaveBeenCalled();
    expect(mocks.cleanupSceneAssetUploads).not.toHaveBeenCalled();
  });

  it("surfaces a conflict without a toast and leaves status idle", async () => {
    mocks.saveScene.mockResolvedValue(
      rejected(APP_ERROR.SCENE_CONFLICT, {
        data: { id: "scene-1", revision: 8, updatedAt: "" },
      }),
    );
    await expect(upload()).resolves.toBe(false);
    expect(hook().status).toBe("idle");
    expect(hook().lastConflict).toEqual({
      sceneId: "scene-1",
      remoteRevision: 8,
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.cleanupSceneAssetUploads).toHaveBeenCalledTimes(1);

    act(() => hook().clearLastConflict());
    expect(hook().lastConflict).toBeNull();
  });

  it("clears the session and notifies when an existing scene is gone", async () => {
    mocks.saveScene.mockResolvedValue(rejected(APP_ERROR.SCENE_NOT_FOUND));
    await expect(upload()).resolves.toBe(false);
    expect(mocks.session.clearCurrentScene).toHaveBeenCalledTimes(1);
    expect(onSceneNotFound).toHaveBeenCalledTimes(1);
    expect(hook().status).toBe("idle");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("re-uploads the assets the server reports missing and commits once more", async () => {
    mocks.readSceneAssetFileIds.mockResolvedValue({
      ok: true,
      fileIds: ["file-1", "file-2"],
    });
    mocks.saveScene
      .mockResolvedValueOnce(
        rejected(APP_ERROR.SCENE_ASSETS_MISSING, {
          missingFileIds: ["file-2"],
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: { id: "scene-1", revision: 4, updatedAt: "" },
      });
    await expect(upload()).resolves.toBe(true);
    expect(mocks.startAssetUpload).toHaveBeenCalledTimes(1);
    expect(mocks.startAssetUpload.mock.calls[0]?.[1]).toMatchObject({
      excalidrawFileId: "file-2",
    });
    expect(mocks.saveScene).toHaveBeenCalledTimes(2);
    expect(mocks.session.syncCurrentScene).toHaveBeenCalledWith({
      id: "scene-1",
      revision: 4,
      workspaceId: "ws-1",
    });
  });
});
