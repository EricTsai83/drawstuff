// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateSceneDraftResult,
  ReadSceneAssetFileIdsResult,
  SaveSceneResult,
} from "@/server/actions";

import { en } from "@/lib/i18n/en";
import {
  hook,
  mocks,
  mountProbe,
  rerender,
  unmountProbe,
  upload,
} from "./support/cloud-upload-harness";

const SCENE_BYTES = new Uint8Array([1, 2, 3]);
const ASSET_BYTES = new Uint8Array([9]);
const saved = (
  id: string,
  revision: number,
  isPublished = false,
): SaveSceneResult => ({
  ok: true,
  data: { id, revision, updatedAt: "2026-01-01T00:00:00.000Z", isPublished },
});

const ARTIFACT_URL = (key: string) => `https://app.ufs.sh/f/${key}`;

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Object.assign(mocks.session, {
    currentSceneId: "scene-1",
    currentWorkspaceId: "ws-1",
    lastSyncedRevision: 3,
  });
  mocks.getCurrentSceneSnapshot.mockReturnValue({
    elements: [],
    appState: { name: "  My scene  " },
    files: {},
  });
  mocks.prepareSceneDataForExport.mockResolvedValue({
    compressedSceneData: SCENE_BYTES,
    compressedFilesData: [{ id: "file-1", buffer: ASSET_BYTES }],
    encryptionKey: null,
  });
  mocks.readSceneAssetFileIds.mockResolvedValue({
    ok: true,
    fileIds: [],
  } satisfies ReadSceneAssetFileIdsResult);
  mocks.startAssetUpload.mockResolvedValue([{ key: "asset-key-1" }]);
  mocks.startThumbnailUpload.mockResolvedValue([
    { serverData: { fileKey: "thumb-key" } },
  ]);
  mocks.saveScene.mockResolvedValue(saved("scene-1", 4));
  mocks.exportSceneThumbnail.mockResolvedValue(new Blob(["png"]));
  mocks.renderPublishedArtifacts.mockResolvedValue({
    artifact: new Blob(["<svg/>"], { type: "image/svg+xml" }),
    engineVersion: "0.18.1",
  });
  mocks.startArtifactUpload.mockImplementation(() =>
    Promise.resolve([
      {
        serverData: {
          fileKey: "artifact-key",
          fileUrl: ARTIFACT_URL("artifact-key"),
        },
      },
    ]),
  );
  mocks.setPublishedArtifacts.mockResolvedValue({ applied: true });
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "scene-new", revision: 0, updatedAt: "" },
  } satisfies CreateSceneDraftResult);
  mocks.cleanupSceneAssetUploads.mockResolvedValue({ success: true });
  mocks.deleteScene.mockResolvedValue(undefined);

  mountProbe();
});

afterEach(unmountProbe);

describe("useCloudUpload success path", () => {
  it("uploads missing assets, commits with the synced revision, and syncs the session", async () => {
    await expect(upload()).resolves.toBe(true);

    expect(mocks.saveScene).toHaveBeenCalledWith({
      id: "scene-1",
      name: "My scene",
      description: "",
      workspaceId: "ws-1",
      data: "AQID",
      categories: undefined,
      expectedRevision: 3,
    });
    expect(mocks.startAssetUpload).toHaveBeenCalledTimes(1);
    const [assetFiles, assetInput] = mocks.startAssetUpload.mock.calls[0] as [
      File[],
      Record<string, unknown>,
    ];
    expect(assetFiles).toHaveLength(1);
    expect(new Uint8Array(await assetFiles[0]!.arrayBuffer())).toEqual(
      ASSET_BYTES,
    );
    expect(assetInput).toEqual({
      sceneId: "scene-1",
      excalidrawFileId: "file-1",
      contentHash: await sha256Hex(ASSET_BYTES),
    });
    expect(mocks.startThumbnailUpload).toHaveBeenCalledWith(
      [expect.any(File)],
      { sceneId: "scene-1" },
    );
    expect(mocks.session.syncCurrentScene).toHaveBeenCalledWith({
      id: "scene-1",
      revision: 4,
      workspaceId: "ws-1",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.success"],
    );
    expect(mocks.invalidateScenes).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateCategories).toHaveBeenCalledTimes(1);
    expect(hook().status).toBe("success");
    expect(mocks.cleanupSceneAssetUploads).not.toHaveBeenCalled();
    expect(mocks.deleteScene).not.toHaveBeenCalled();
  });

  it("skips assets the scene already stores and honours caller overrides", async () => {
    mocks.readSceneAssetFileIds.mockResolvedValue({
      ok: true,
      fileIds: ["file-1"],
    });
    await expect(
      upload({
        name: "Renamed",
        description: "d",
        categories: ["c1"],
        suppressSuccessToast: true,
      }),
    ).resolves.toBe(true);
    expect(mocks.startAssetUpload).not.toHaveBeenCalled();
    expect(mocks.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Renamed",
        description: "d",
        categories: ["c1"],
      }),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("creates a draft first in create mode and commits against its revision", async () => {
    mocks.saveScene.mockResolvedValue(saved("scene-new", 1));
    await expect(upload({ mode: "create", workspaceId: "ws-2" })).resolves.toBe(
      true,
    );
    expect(mocks.createSceneDraft).toHaveBeenCalledWith({
      name: "My scene",
      description: "",
      workspaceId: "ws-2",
    });
    expect(mocks.readSceneAssetFileIds).not.toHaveBeenCalled();
    expect(mocks.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "scene-new",
        expectedRevision: 0,
        workspaceId: "ws-2",
      }),
    );
  });

  it("recovers a missing revision from the server before committing", async () => {
    mocks.session.lastSyncedRevision = undefined;
    rerender();
    mocks.getSceneMeta.mockResolvedValue({ revision: 9 });
    await expect(upload()).resolves.toBe(true);
    expect(mocks.getSceneMeta).toHaveBeenCalledWith("scene-1");
    expect(mocks.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 9 }),
    );
  });

  it("leaves published artifacts alone for a private scene", async () => {
    await expect(upload()).resolves.toBe(true);
    expect(mocks.renderPublishedArtifacts).not.toHaveBeenCalled();
    expect(mocks.startArtifactUpload).not.toHaveBeenCalled();
    expect(mocks.setPublishedArtifacts).not.toHaveBeenCalled();
  });

  it("re-renders and replaces both artifacts after saving a published scene", async () => {
    mocks.saveScene.mockResolvedValue(saved("scene-1", 4, true));
    await expect(upload()).resolves.toBe(true);

    expect(mocks.renderPublishedArtifacts).toHaveBeenCalledWith({
      elements: [],
      appState: { name: "  My scene  " },
      files: {},
    });
    // One artifact now serves both themes, so one object is uploaded.
    expect(mocks.startArtifactUpload).toHaveBeenCalledTimes(1);
    mocks.startArtifactUpload.mock.calls.forEach(([files, input]) => {
      const [file] = files as File[];
      const upload = input as { sceneId: string; contentHash: string };
      expect(upload.sceneId).toBe("scene-1");
      expect(upload.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(file?.type).toBe("image/svg+xml");
      expect(file?.name).toBe(`scene-${upload.contentHash}.svg`);
    });
    expect(mocks.setPublishedArtifacts).toHaveBeenCalledWith({
      id: "scene-1",
      artifacts: {
        artifact: { key: "artifact-key", url: ARTIFACT_URL("artifact-key") },
        engineVersion: "0.18.1",
        // The revision the save returned, not the one it started from.
        revision: 4,
      },
    });
    expect(hook().status).toBe("success");
  });

  it("keeps the commit when the published artifacts fail, and tells the author", async () => {
    mocks.saveScene.mockResolvedValue(saved("scene-1", 4, true));
    mocks.startArtifactUpload.mockRejectedValue(new Error("svg down"));
    await expect(upload()).resolves.toBe(true);
    expect(mocks.setPublishedArtifacts).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to render/upload published artifacts after cloud upload:",
      expect.any(Error),
    );
    // The save succeeded, so the failure is a warning with the sizes that
    // matter for an oversized artifact, not a save error.
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.publishedArtifactsUpload"].replace(
        "{size}",
        "0.0 MB",
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.success"],
    );
    // The thumbnail is independent of the artifacts.
    expect(mocks.startThumbnailUpload).toHaveBeenCalledTimes(1);
    expect(mocks.session.syncCurrentScene).toHaveBeenCalledTimes(1);
    expect(hook().status).toBe("success");
  });

  it("reports a render failure without artifact sizes", async () => {
    mocks.saveScene.mockResolvedValue(saved("scene-1", 4, true));
    mocks.renderPublishedArtifacts.mockRejectedValue(new Error("no canvas"));
    await expect(upload()).resolves.toBe(true);
    expect(mocks.startArtifactUpload).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      en["app.cloudUpload.toast.error.publishedArtifactsRender"],
    );
    expect(hook().status).toBe("success");
  });

  it("keeps the commit when only the thumbnail fails", async () => {
    mocks.startThumbnailUpload.mockRejectedValue(new Error("thumb down"));
    await expect(upload()).resolves.toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to generate/upload thumbnail after cloud upload:",
      expect.any(Error),
    );
    expect(mocks.session.syncCurrentScene).toHaveBeenCalledTimes(1);
    expect(hook().status).toBe("success");
  });
});
