import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import type { SaveSceneResult } from "@/server/actions";

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
      scene: { getUserScenesInfinite: { invalidate: vi.fn() } },
      category: { list: { invalidate: vi.fn() } },
    }),
    scene: {
      deleteScene: { useMutation: () => ({ mutateAsync: mocks.deleteScene }) },
    },
  },
}));
vi.mock("@/lib/excalidraw", () => ({
  getCurrentSceneSnapshot: mocks.getCurrentSceneSnapshot,
  exportSceneThumbnail: () => Promise.resolve(new Blob(["png"])),
}));
vi.mock("@/lib/export-scene-to-backend", () => ({
  prepareSceneDataForExport: () =>
    Promise.resolve({
      compressedSceneData: new Uint8Array([1]),
      compressedFilesData: [
        { id: "file-1", buffer: new Uint8Array([1]) },
        { id: "file-2", buffer: new Uint8Array([2]) },
      ],
      encryptionKey: null,
    }),
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
import { APP_ERROR } from "@/lib/errors";
import { en } from "@/lib/i18n/en";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useCloudUpload>;
const probe: { hook?: Hook } = {};
const onSceneNotFound = vi.fn();

function Probe() {
  const hook = useCloudUpload(onSceneNotFound, {} as ExcalidrawImperativeAPI);
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
  uploadKeyed();
  mocks.startThumbnailUpload.mockResolvedValue([{ key: "thumb" }]);
  mocks.saveScene.mockResolvedValue({
    ok: true,
    data: { id: "scene-1", revision: 4, updatedAt: "" },
  } satisfies SaveSceneResult);
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "scene-new", revision: 0, updatedAt: "" },
  });
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
