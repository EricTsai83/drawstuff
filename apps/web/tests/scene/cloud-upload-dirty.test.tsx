// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppState,
  ExcalidrawElement,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";
import type * as SceneSessionModule from "@/hooks/scene-session-context";
import {
  preservePersonalDraft,
  restorePersonalDraft,
} from "@/lib/collab/personal-draft";
import { resumeLocalScenePersistence } from "@/data/local-scene-persistence";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  hook,
  mocks,
  mountProbe,
  rerender,
  unmountProbe,
} from "../support/cloud-upload-harness";

// Keep the real state transitions and browser persistence behind the upload
// harness's session callbacks, rather than mocking dirty=false/true ourselves.
const { SceneSessionProvider, useSceneSession } = await vi.importActual<
  typeof SceneSessionModule
>("@/hooks/scene-session-context");
let session!: ReturnType<typeof useSceneSession>;
function SessionProbe() {
  const current = useSceneSession();
  useEffect(() => {
    session = current;
  }, [current]);
  return null;
}
let root: ReturnType<typeof createRoot>;
const scene = {
  elements: [] as ExcalidrawElement[],
  appState: { name: "Scene" } as Partial<AppState>,
  files: {},
};

function createCanvasApi(): ExcalidrawImperativeAPI {
  return {
    getSceneElementsIncludingDeleted: () => scene.elements,
    getAppState: () => scene.appState,
    getFiles: () => scene.files,
    resetScene: () => {
      scene.elements = [];
    },
    updateScene: (next: {
      elements?: ExcalidrawElement[];
      appState?: Partial<AppState>;
    }) => {
      if (next.elements) scene.elements = next.elements;
      if (next.appState) scene.appState = next.appState;
    },
    addFiles: () => undefined,
  } as unknown as ExcalidrawImperativeAPI;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resumeLocalScenePersistence("collaboration-canvas");
  root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <SceneSessionProvider>
        <SessionProbe />
      </SceneSessionProvider>,
    ),
  );
  scene.elements = [
    {
      id: "rect",
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
    } as ExcalidrawElement,
  ];
  scene.appState = { name: "Scene" };
  mocks.getCurrentSceneSnapshot.mockReturnValue(scene);
  mocks.session.getCanvasSaveGeneration = () =>
    session.getCanvasSaveGeneration();
  mocks.session.getCurrentSceneIdentity = () =>
    session.getCurrentSceneIdentity();
  mocks.session.syncCurrentScene.mockImplementation(
    (params: Parameters<typeof session.syncCurrentScene>[0]) =>
      session.syncCurrentScene(params),
  );
  mocks.session.getCanvasGeneration.mockImplementation(() =>
    session.getCanvasGeneration(),
  );
  mocks.session.markCurrentSceneDirty.mockImplementation(() =>
    session.markCurrentSceneDirty(),
  );
  mocks.prepareSceneDataForExport.mockResolvedValue({
    compressedSceneData: new Uint8Array([1]),
    compressedFilesData: [],
  });
  mocks.readSceneAssetFileIds.mockResolvedValue({ ok: true, fileIds: [] });
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "new", revision: 0 },
  });
  mocks.saveScene.mockResolvedValue({
    ok: true,
    data: { id: "scene", revision: 4, isPublished: false },
  });
  mocks.exportSceneThumbnail.mockResolvedValue(new Blob(["png"]));
  mocks.startThumbnailUpload.mockResolvedValue([{ key: "thumb" }]);
});
afterEach(() => {
  unmountProbe();
  act(() => root.unmount());
  resumeLocalScenePersistence("collaboration-canvas");
  sessionStorage.clear();
});

function mountUpload(firstSave = false) {
  act(() => {
    if (firstSave) session.updateCurrentWorkspaceId("ws");
    else {
      session.syncCurrentScene({ id: "scene", revision: 3, workspaceId: "ws" });
      session.markCurrentSceneDirty();
    }
  });
  Object.assign(mocks.session, {
    currentSceneId: session.currentSceneId,
    currentWorkspaceId: session.currentWorkspaceId,
    lastSyncedRevision: session.lastSyncedRevision,
  });
  mountProbe();
}

async function saveWithEdit(edit: () => void) {
  let began!: () => void;
  let finish!: (value: { key: string }[]) => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const pending = new Promise<{ key: string }[]>((resolve) => {
    finish = resolve;
  });
  mocks.startThumbnailUpload.mockImplementation(() => {
    began();
    return pending;
  });
  await act(async () => {
    const saving = hook().uploadSceneToCloud();
    await started;
    edit();
    finish([{ key: "thumb" }]);
    expect(await saving).toBe(true);
  });
}

describe("acknowledging only the uploaded snapshot", () => {
  it("keeps newer edits dirty while advancing the real session revision", async () => {
    mountUpload();
    await saveWithEdit(() => {
      Object.assign(scene.elements[0]!, { version: 2 });
      session.markCurrentSceneDirty();
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: "scene",
      revision: 4,
      isDirty: true,
    });
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY)).toBe(
      "true",
    );
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION)).toBe("4");
  });

  it("binds a first save to its new ID without losing edits made while it was unsaved", async () => {
    mountUpload(true);
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "new", revision: 1, isPublished: false },
    });
    await saveWithEdit(() => {
      // No currentSceneId exists yet, so the editor would not call markDirty.
      Object.assign(scene.elements[0]!, { versionNonce: 2 });
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: "new",
      revision: 1,
      isDirty: true,
    });
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY)).toBe(
      "true",
    );
  });

  it("clears dirty when content is unchanged despite viewport or sidebar changes", async () => {
    mountUpload();
    await saveWithEdit(() => {
      scene.appState.scrollX = 123;
      scene.appState.zoom = { value: 2 } as AppState["zoom"];
      scene.appState.openSidebar = { name: "default" };
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      revision: 4,
      isDirty: false,
    });
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_IS_DIRTY)).toBe(
      "false",
    );
  });

  it("preserves app-state edits such as the background", async () => {
    mountUpload();
    await saveWithEdit(() => {
      scene.appState.viewBackgroundColor = "#ff0000";
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      revision: 4,
      isDirty: true,
    });
  });

  it("does not acknowledge an old upload after switching away and back to the same ID", async () => {
    mountUpload();
    await saveWithEdit(() => {
      session.syncCurrentScene({ id: "other", revision: 1 });
      session.syncCurrentScene({ id: "scene", revision: 9 });
      Object.assign(mocks.session, {
        currentSceneId: "scene",
        lastSyncedRevision: 9,
      });
      rerender();
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: "scene",
      revision: 9,
      isDirty: false,
    });
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
  });

  it("uses the acknowledged revision for the next save of the remaining edits", async () => {
    mountUpload();
    await saveWithEdit(() => {
      Object.assign(scene.elements[0]!, { version: 2 });
    });
    Object.assign(mocks.session, {
      lastSyncedRevision: session.lastSyncedRevision,
    });
    rerender();
    mocks.startThumbnailUpload.mockResolvedValue([{ key: "thumb" }]);
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "scene", revision: 5, isPublished: false },
    });
    await act(async () => {
      expect(await hook().uploadSceneToCloud()).toBe(true);
    });
    expect(mocks.saveScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 4 }),
    );
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      revision: 5,
      isDirty: false,
    });
  });

  it.each(["gridModeEnabled", "gridStep"] as const)(
    "keeps changes to %s dirty",
    async (key) => {
      mountUpload();
      await saveWithEdit(() => {
        if (key === "gridModeEnabled") scene.appState.gridModeEnabled = true;
        else scene.appState.gridStep = 10;
      });
      expect(session.getCurrentSceneIdentity()).toMatchObject({
        revision: 4,
        isDirty: true,
      });
    },
  );

  it("does not roll back a newer rename revision while finishing the thumbnail", async () => {
    mountUpload();
    await saveWithEdit(() => {
      scene.appState.name = "Renamed";
      session.updateLastSyncedRevision(5);
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      revision: 5,
      isDirty: true,
    });
    expect(localStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION)).toBe("5");
  });

  it("does not use the old scene's higher revision when creating a copy", async () => {
    mountUpload();
    act(() => session.updateLastSyncedRevision(9));
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "new", revision: 1, isPublished: false },
    });
    await act(async () => {
      expect(await hook().uploadSceneToCloud({ mode: "create" })).toBe(true);
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: "new",
      revision: 1,
    });
  });

  it.each([false, true])(
    "keeps the newer personal draft when a save finishes in a room (first save: %s)",
    async (firstSave) => {
      mountUpload(firstSave);
      if (firstSave)
        mocks.saveScene.mockResolvedValue({
          ok: true,
          data: { id: "new", revision: 1, isPublished: false },
        });
      const api = createCanvasApi();
      await saveWithEdit(() => {
        Object.assign(scene.elements[0]!, { version: 2 });
        scene.appState.gridModeEnabled = true;
        scene.appState.gridStep = 10;
        preservePersonalDraft(
          api,
          () => undefined,
          session.getCurrentSceneIdentity(),
          session.getCanvasSaveGeneration(),
        );
        session.clearCurrentScene();
        scene.elements = []; // A room now owns a different canvas.
      });
      await act(async () => {
        expect(restorePersonalDraft(api, session.reloadSceneSession)).toBe(
          true,
        );
      });
      expect(scene.elements[0]?.version).toBe(2);
      expect(scene.appState).toMatchObject({
        gridModeEnabled: true,
        gridStep: 10,
      });
      expect(session.getCurrentSceneIdentity()).toMatchObject({
        id: firstSave ? "new" : "scene",
        revision: firstSave ? 1 : 4,
        isDirty: true,
      });
    },
  );

  it.each([false, true])(
    "does not bind an old upload to a replacement draft (first save: %s)",
    async (firstSave) => {
      mountUpload(firstSave);
      if (firstSave)
        mocks.saveScene.mockResolvedValue({
          ok: true,
          data: { id: "new", revision: 1, isPublished: false },
        });
      const api = createCanvasApi();
      await saveWithEdit(() => {
        if (firstSave) session.clearCurrentScene();
        else session.syncCurrentScene({ id: "scene", revision: 3 });
        scene.elements = [{ ...scene.elements[0]!, id: "replacement" }];
        preservePersonalDraft(
          api,
          () => undefined,
          session.getCurrentSceneIdentity(),
          session.getCanvasSaveGeneration(),
        );
        session.clearCurrentScene();
        scene.elements = [];
      });
      await act(async () => {
        expect(restorePersonalDraft(api, session.reloadSceneSession)).toBe(
          true,
        );
      });
      expect(scene.elements[0]?.id).toBe("replacement");
      expect(session.getCurrentSceneIdentity()).toMatchObject({
        id: firstSave ? undefined : "scene",
        revision: firstSave ? undefined : 3,
      });
    },
  );

  it.each([false, true])(
    "acknowledges a save that finishes after leaving the room (first save: %s)",
    async (firstSave) => {
      mountUpload(firstSave);
      const id = firstSave ? "new" : "scene";
      const revision = firstSave ? 1 : 4;
      if (firstSave)
        mocks.saveScene.mockResolvedValue({
          ok: true,
          data: { id, revision, isPublished: false },
        });
      const api = createCanvasApi();
      const originalGeneration = session.getCanvasGeneration();
      await saveWithEdit(() => {
        Object.assign(scene.elements[0]!, { version: 2 });
        // Multiple room round trips must preserve the original save identity.
        for (let hop = 0; hop < 2; hop += 1) {
          preservePersonalDraft(
            api,
            () => undefined,
            session.getCurrentSceneIdentity(),
            session.getCanvasSaveGeneration(),
          );
          session.clearCurrentScene();
          scene.elements = [];
          expect(restorePersonalDraft(api, session.reloadSceneSession)).toBe(
            true,
          );
        }
        expect(session.getCanvasGeneration()).toBeGreaterThan(
          originalGeneration,
        );
        expect(session.getCanvasSaveGeneration()).toBe(originalGeneration);
      });
      expect(session.getCurrentSceneIdentity()).toMatchObject({
        id,
        revision,
        isDirty: true,
      });
      expect(scene.elements[0]?.version).toBe(2);
      Object.assign(mocks.session, {
        currentSceneId: session.currentSceneId,
        currentWorkspaceId: session.currentWorkspaceId,
        lastSyncedRevision: session.lastSyncedRevision,
      });
      rerender();
      mocks.startThumbnailUpload.mockResolvedValue([{ key: "thumb" }]);
      mocks.saveScene.mockResolvedValue({
        ok: true,
        data: { id, revision: revision + 1, isPublished: false },
      });
      await act(async () => {
        expect(await hook().uploadSceneToCloud()).toBe(true);
      });
      expect(mocks.saveScene).toHaveBeenLastCalledWith(
        expect.objectContaining({ id, expectedRevision: revision }),
      );
      expect(mocks.createSceneDraft).toHaveBeenCalledTimes(firstSave ? 1 : 0);
      expect(session.getCurrentSceneIdentity()).toMatchObject({
        revision: revision + 1,
        isDirty: false,
      });
    },
  );

  it("does not carry restored save identity into a new canvas", async () => {
    mountUpload(true);
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "new", revision: 1, isPublished: false },
    });
    const api = createCanvasApi();
    await saveWithEdit(() => {
      preservePersonalDraft(
        api,
        () => undefined,
        session.getCurrentSceneIdentity(),
        session.getCanvasSaveGeneration(),
      );
      session.clearCurrentScene();
      expect(restorePersonalDraft(api, session.reloadSceneSession)).toBe(true);
      session.clearCurrentScene();
      scene.elements = [{ ...scene.elements[0]!, id: "replacement" }];
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: undefined,
      revision: undefined,
    });
    expect(scene.elements[0]?.id).toBe("replacement");
  });

  it("invalidates restored save identity on an ordinary session reload", async () => {
    mountUpload();
    const api = createCanvasApi();
    await saveWithEdit(() => {
      preservePersonalDraft(
        api,
        () => undefined,
        session.getCurrentSceneIdentity(),
        session.getCanvasSaveGeneration(),
      );
      session.clearCurrentScene();
      expect(restorePersonalDraft(api, session.reloadSceneSession)).toBe(true);
      session.reloadSceneSession();
    });
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: "scene",
      revision: 3,
    });
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
  });

  it("cannot reuse a restored generation for a later replacement canvas", async () => {
    mountUpload(true);
    act(() => session.reloadSceneSession(3));
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "new", revision: 1, isPublished: false },
    });
    await saveWithEdit(() => {
      session.clearCurrentScene();
      session.clearCurrentScene();
      scene.elements = [{ ...scene.elements[0]!, id: "replacement" }];
    });
    expect(session.getCanvasSaveGeneration()).toBeGreaterThan(3);
    expect(session.getCurrentSceneIdentity()).toMatchObject({
      id: undefined,
      revision: undefined,
    });
  });
});
