import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

/**
 * Everything `useCloudUpload` reaches, as mocks the suites script per test.
 * Shared by the success-path and failure-path suites so the module map cannot
 * drift between them; each file still gets its own module instance.
 */
export const mocks = {
  createSceneDraft: vi.fn(),
  saveScene: vi.fn(),
  readSceneAssetFileIds: vi.fn(),
  cleanupSceneAssetUploads: vi.fn(),
  startAssetUpload: vi.fn(),
  startThumbnailUpload: vi.fn(),
  startArtifactUpload: vi.fn(),
  setPublishedArtifacts: vi.fn(),
  renderPublishedArtifacts: vi.fn(),
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
};

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
        : endpoint === "publishedArtifactUploader"
          ? mocks.startArtifactUpload
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
      setPublishedArtifacts: {
        useMutation: () => ({ mutateAsync: mocks.setPublishedArtifacts }),
      },
    },
  },
}));
vi.mock("@/lib/render-published-artifacts", () => ({
  renderPublishedArtifacts: mocks.renderPublishedArtifacts,
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

// Imported after the mocks above exist: vitest hoists `vi.mock` calls and
// static imports together, and the hook module is what triggers the factories.
const { useCloudUpload } = await import("@/hooks/use-cloud-upload");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useCloudUpload>;
const probe: { hook?: Hook } = {};
export const onSceneNotFound = vi.fn();

function Probe() {
  const hook = useCloudUpload(onSceneNotFound, {} as ExcalidrawImperativeAPI);
  useEffect(() => {
    probe.hook = hook;
  }, [hook]);
  return null;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

/** Mounts the probe; call at the end of `beforeEach`, after the mocks are scripted. */
export const mountProbe = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  act(() => mounted.render(<Probe />));
};

/** Unmounts the probe and clears every mock's calls; call from `afterEach`. */
export const unmountProbe = (): void => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  probe.hook = undefined;
  vi.clearAllMocks();
};

export const hook = (): Hook => {
  if (!probe.hook) throw new Error("hook probe not ready");
  return probe.hook;
};

/** The hook snapshots session values into refs on render, so a changed session
 *  is only seen after another render. */
export const rerender = (): void => {
  const mounted = root;
  if (!mounted) throw new Error("probe not mounted");
  act(() => mounted.render(<Probe />));
};

export const upload = async (
  options?: Parameters<Hook["uploadSceneToCloud"]>[0],
) => {
  let result: boolean | undefined;
  await act(async () => {
    result = await hook().uploadSceneToCloud(options);
  });
  return result;
};
