import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import type {
  CreateSceneDraftResult,
  ReadSceneAssetFileIdsResult,
  SaveSceneResult,
} from "@/server/actions";

const mocks = vi.hoisted(() => ({
  createSceneDraft: vi.fn(),
  saveScene: vi.fn(),
  readSceneAssetFileIds: vi.fn(),
  cleanupSceneAssetUploads: vi.fn(),
  startAssetUpload: vi.fn(),
  startThumbnailUpload: vi.fn(),
  deleteScene: vi.fn(),
  getSceneMeta: vi.fn(),
  getCurrentSceneSnapshot: vi.fn(),
  exportSceneThumbnail: vi.fn(),
  prepareSceneDataForExport: vi.fn(),
  invalidateScenes: vi.fn(),
  invalidateCategories: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  session: {
    currentSceneId: undefined as string | undefined,
    currentWorkspaceId: undefined as string | undefined,
    lastSyncedRevision: undefined as number | undefined,
    syncCurrentScene: vi.fn(),
    clearCurrentScene: vi.fn(),
    markCurrentSceneDirty: vi.fn(),
  },
}));

vi.mock("@/server/actions", () => ({
  createSceneDraftAction: mocks.createSceneDraft,
  saveSceneAction: mocks.saveScene,
  readSceneAssetFileIdsAction: mocks.readSceneAssetFileIds,
  cleanupSceneAssetUploadsAction: mocks.cleanupSceneAssetUploads,
}));
vi.mock("@/lib/uploadthing", () => ({
  useUploadThing: (endpoint: string) => ({
    startUpload:
      endpoint === "sceneAssetUploader"
        ? mocks.startAssetUpload
        : mocks.startThumbnailUpload,
  }),
}));
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      scene: { getUserScenesInfinite: { invalidate: mocks.invalidateScenes } },
      category: { list: { invalidate: mocks.invalidateCategories } },
    }),
    scene: {
      deleteScene: { useMutation: () => ({ mutateAsync: mocks.deleteScene }) },
    },
  },
}));
vi.mock("@/lib/excalidraw", () => ({
  getCurrentSceneSnapshot: mocks.getCurrentSceneSnapshot,
  exportSceneThumbnail: mocks.exportSceneThumbnail,
}));
vi.mock("@/lib/export-scene-to-backend", () => ({
  prepareSceneDataForExport: mocks.prepareSceneDataForExport,
}));
vi.mock("@/lib/import-data-from-db", () => ({
  getSceneMetaBySceneId: mocks.getSceneMeta,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});
vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => mocks.session,
}));

import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { en } from "@/lib/i18n/en";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useCloudUpload>;
const probe: { hook?: Hook } = {};
const onSceneNotFound = vi.fn();
const excalidrawAPI = {} as ExcalidrawImperativeAPI;

function Probe() {
  const hook = useCloudUpload(onSceneNotFound, excalidrawAPI);
  useEffect(() => {
    probe.hook = hook;
  }, [hook]);
  return null;
}

let container: HTMLDivElement;
let root: Root;

const hook = (): Hook => {
  if (!probe.hook) throw new Error("hook probe not ready");
  return probe.hook;
};

/** The hook snapshots session values into refs on render, so a changed session
 *  is only seen after another render. */
const rerender = (): void => {
  act(() => root.render(<Probe />));
};

const upload = async (options?: Parameters<Hook["uploadSceneToCloud"]>[0]) => {
  let result: boolean | undefined;
  await act(async () => {
    result = await hook().uploadSceneToCloud(options);
  });
  return result;
};

const SCENE_BYTES = new Uint8Array([1, 2, 3]);
const ASSET_BYTES = new Uint8Array([9]);
const saved = (id: string, revision: number): SaveSceneResult => ({
  ok: true,
  data: { id, revision, updatedAt: "2026-01-01T00:00:00.000Z" },
});

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
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "scene-new", revision: 0, updatedAt: "" },
  } satisfies CreateSceneDraftResult);
  mocks.cleanupSceneAssetUploads.mockResolvedValue({ success: true });
  mocks.deleteScene.mockResolvedValue(undefined);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  probe.hook = undefined;
  vi.clearAllMocks();
});

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
