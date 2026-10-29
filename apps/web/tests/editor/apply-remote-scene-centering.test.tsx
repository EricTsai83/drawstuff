// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExcalidrawElement,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";

const { importSceneData, importSceneFiles, saveToLocalStorage, session } =
  vi.hoisted(() => ({
    importSceneData: vi.fn(),
    importSceneFiles: vi.fn(),
    saveToLocalStorage: vi.fn(() => true),
    session: {
      suppressDirtyTracking: vi.fn(),
      resumeDirtyTracking: vi.fn(),
      syncCurrentScene: vi.fn(),
      getCanvasGeneration: vi.fn(() => 0),
      getCurrentSceneIdentity: vi.fn(() => ({ isDirty: false })),
    },
  }));

vi.mock("@/lib/import-data-from-db", () => ({
  importSceneDataBySceneId: importSceneData,
  importSceneFilesBySceneId: importSceneFiles,
}));

/** Mocked so the hook imports no canvas machinery; hydration has its own tests. */
vi.mock("@/lib/excalidraw", () => ({
  hasCompleteSceneFileHydration: () => true,
  saveToLocalStorage,
}));

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => session,
}));

import { useApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";
import { STORAGE_KEYS } from "@/config/app-constants";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useApplyRemoteScene>;
const probe: { hook?: Hook } = {};

function Probe({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const hook = useApplyRemoteScene(api);
  useEffect(() => {
    probe.hook = hook;
  }, [hook]);
  return null;
}

/** Only the members the hook touches; `elements` is what `getSceneElements` returns. */
function createApiStub() {
  const scene = { elements: [] as readonly ExcalidrawElement[] };
  const api = {
    getAppState: vi.fn(() => ({ theme: "light" })),
    updateScene: vi.fn(),
    getSceneElements: vi.fn(() => scene.elements),
    getSceneElementsIncludingDeleted: vi.fn(() => scene.elements),
    scrollToContent: vi.fn(),
    getFiles: () => ({}),
    addFiles: vi.fn(),
  };
  const showContent = () => {
    scene.elements = [
      { id: "rect", isDeleted: false } as unknown as ExcalidrawElement,
    ];
  };
  return {
    api: api as unknown as ExcalidrawImperativeAPI,
    spies: api,
    showContent,
  };
}

let container: HTMLDivElement;
let root: Root;

const mount = (api: ExcalidrawImperativeAPI | null) => {
  act(() => root.render(<Probe api={api} />));
  if (!probe.hook) throw new Error("hook probe not ready");
  return probe.hook;
};

const apply = async (hook: Hook, sceneId: string) => {
  let result: Awaited<ReturnType<Hook["applyRemoteScene"]>> | undefined;
  await act(async () => {
    result = await hook.applyRemoteScene({ sceneId });
  });
  return result;
};

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  importSceneData.mockResolvedValue({ elements: [], revision: 7 });
  importSceneFiles.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  probe.hook = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useApplyRemoteScene centering", () => {
  it("returns scene_data_missing without an API and schedules nothing", async () => {
    const hook = mount(null);
    await expect(apply(hook, "scene-1")).resolves.toEqual({
      ok: false,
      reason: "scene_data_missing",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries until content appears, centers once, then stops", async () => {
    const { api, spies, showContent } = createApiStub();
    const hook = mount(api);
    await apply(hook, "scene-1");

    expect(spies.updateScene).toHaveBeenCalledTimes(1);
    expect(session.suppressDirtyTracking).toHaveBeenCalledTimes(1);
    expect(spies.scrollToContent).not.toHaveBeenCalled();

    // Attempt 1 (0ms) and 2 (80ms) see an empty canvas.
    advance(0);
    advance(80);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(2);
    expect(spies.scrollToContent).not.toHaveBeenCalled();

    showContent();
    advance(80);
    expect(spies.scrollToContent).toHaveBeenCalledTimes(1);
    expect(spies.scrollToContent).toHaveBeenCalledWith(undefined, {
      fitToViewport: true,
      viewportZoomFactor: 0.5,
      animate: false,
    });

    // The chain is finished: no further polls, no second scroll.
    advance(5_000);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(3);
    expect(spies.scrollToContent).toHaveBeenCalledTimes(1);
  });

  it("gives up after ten empty attempts", async () => {
    const { api, spies } = createApiStub();
    const hook = mount(api);
    await apply(hook, "scene-1");

    advance(0);
    advance(9 * 80);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(10);

    advance(5_000);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(10);
    expect(spies.scrollToContent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a newer apply cancel the previous retry chain", async () => {
    const { api, spies, showContent } = createApiStub();
    const hook = mount(api);

    await apply(hook, "scene-1");
    advance(0); // first chain: attempt 1, empty
    expect(spies.getSceneElements).toHaveBeenCalledTimes(1);

    await apply(hook, "scene-2");
    showContent();
    // Had the first chain survived, its 80ms retry would also center now.
    advance(0);
    advance(5_000);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(2);
    expect(spies.scrollToContent).toHaveBeenCalledTimes(1);
  });

  it("cancels pending centering when the hook unmounts", async () => {
    const { api, spies, showContent } = createApiStub();
    const hook = mount(api);
    await apply(hook, "scene-1");
    advance(0);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container); // afterEach unmounts whatever is current
    showContent();
    advance(5_000);
    expect(spies.getSceneElements).toHaveBeenCalledTimes(1);
    expect(spies.scrollToContent).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["scrollX", { scrollX: 120 }],
    ["scrollY", { scrollY: -40 }],
    ["zoom", { zoom: { value: 1.5 } }],
  ])(
    "does not center when the imported appState carries %s",
    async (_key, appState) => {
      importSceneData.mockResolvedValue({
        elements: [],
        appState,
        revision: 7,
      });
      const { api, spies, showContent } = createApiStub();
      const hook = mount(api);
      await apply(hook, "scene-1");
      showContent();
      advance(5_000);
      expect(spies.getSceneElements).not.toHaveBeenCalled();
      expect(spies.scrollToContent).not.toHaveBeenCalled();
    },
  );

  it("does not center when the caller opts out", async () => {
    const { api, spies, showContent } = createApiStub();
    const hook = mount(api);
    await act(async () => {
      await hook.applyRemoteScene({ sceneId: "scene-1", shouldCenter: false });
    });
    showContent();
    advance(5_000);
    expect(spies.scrollToContent).not.toHaveBeenCalled();
    expect(session.syncCurrentScene).toHaveBeenCalledWith({
      id: "scene-1",
      revision: 7,
      workspaceId: undefined,
    });
  });

  it("reports missing scene data when the import fails and schedules nothing", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    importSceneData.mockRejectedValue(new Error("offline"));
    const { api, spies } = createApiStub();
    const hook = mount(api);
    await expect(apply(hook, "scene-1")).resolves.toEqual({
      ok: false,
      reason: "scene_data_missing",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(spies.updateScene).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useApplyRemoteScene local cache", () => {
  const seedPreviousScene = () => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "previous");
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "previous-files");
  };

  it("drops the previous scene's cache when the new one cannot be cached", async () => {
    seedPreviousScene();
    saveToLocalStorage.mockReturnValueOnce(false);
    const hook = mount(createApiStub().api);

    await apply(hook, "scene-b");

    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_FILES)).toBeNull();
    expect(session.syncCurrentScene).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scene-b" }),
    );
  });

  it("keeps the cache the save just wrote", async () => {
    seedPreviousScene();
    const hook = mount(createApiStub().api);

    await apply(hook, "scene-b");

    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      "previous",
    );
  });
});

function deferredScene() {
  let resolve!: (value: { elements: never[]; revision: number }) => void;
  const promise = new Promise<{ elements: never[]; revision: number }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

describe("remote load validity", () => {
  it("ignores a late A response after B has loaded, even if cancellation is ignored", async () => {
    const { api, spies } = createApiStub();
    const hook = mount(api);
    const a = deferredScene();
    importSceneData.mockImplementation((id: string) =>
      id === "A" ? a.promise : Promise.resolve({ elements: [], revision: 2 }),
    );
    const first = hook.applyRemoteScene({ sceneId: "A" });
    const signal = importSceneData.mock.calls[0]![1] as AbortSignal;
    await hook.applyRemoteScene({ sceneId: "B" });
    expect(signal.aborted).toBe(true);
    a.resolve({ elements: [], revision: 1 });
    expect(await first).toEqual({ ok: false, reason: "superseded" });
    expect(spies.updateScene).toHaveBeenCalledTimes(1);
    expect(saveToLocalStorage).toHaveBeenCalledTimes(1);
    expect(session.syncCurrentScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "B" }),
    );
  });

  it("invalidates a load when the canvas session is cleared, including an empty new canvas", async () => {
    const { api, spies } = createApiStub();
    const hook = mount(api);
    const a = deferredScene();
    importSceneData.mockReturnValue(a.promise);
    const loading = hook.applyRemoteScene({ sceneId: "A" });
    session.getCanvasGeneration.mockReturnValueOnce(1);
    a.resolve({ elements: [], revision: 1 });
    expect(await loading).toEqual({ ok: false, reason: "superseded" });
    expect(spies.updateScene).not.toHaveBeenCalled();
    expect(saveToLocalStorage).not.toHaveBeenCalled();
  });

  it("keeps edits made during loading", async () => {
    const { api, spies, showContent } = createApiStub();
    const hook = mount(api);
    const a = deferredScene();
    importSceneData.mockReturnValue(a.promise);
    const loading = hook.applyRemoteScene({ sceneId: "A" });
    showContent();
    a.resolve({ elements: [], revision: 1 });
    expect(await loading).toEqual({ ok: false, reason: "canvas_changed" });
    expect(spies.updateScene).not.toHaveBeenCalled();
    expect(session.syncCurrentScene).not.toHaveBeenCalled();
  });

  it("does not let a background refresh supersede an explicit load", async () => {
    const { api } = createApiStub();
    const hook = mount(api);
    const a = deferredScene();
    importSceneData.mockReturnValue(a.promise);
    const loading = hook.applyRemoteScene({ sceneId: "B" });
    expect(
      await hook.applyRemoteScene({ sceneId: "A", background: true }),
    ).toEqual({ ok: false, reason: "superseded" });
    expect(importSceneData).toHaveBeenCalledTimes(1);
    a.resolve({ elements: [], revision: 1 });
    expect((await loading).ok).toBe(true);
  });

  it("aborts pending work on unmount and never writes its result", async () => {
    const { api, spies } = createApiStub();
    const hook = mount(api);
    const a = deferredScene();
    importSceneData.mockReturnValue(a.promise);
    const loading = hook.applyRemoteScene({ sceneId: "A" });
    const signal = importSceneData.mock.calls[0]![1] as AbortSignal;
    act(() => root.render(null));
    expect(signal.aborted).toBe(true);
    a.resolve({ elements: [], revision: 1 });
    expect(await loading).toEqual({ ok: false, reason: "superseded" });
    expect(spies.updateScene).not.toHaveBeenCalled();
  });
});

it("allows viewport and sidebar changes while a scene is loading", async () => {
  const { api, spies } = createApiStub();
  const hook = mount(api);
  const a = deferredScene();
  importSceneData.mockReturnValue(a.promise);
  const loading = hook.applyRemoteScene({ sceneId: "A" });
  spies.getAppState.mockImplementation(() => ({
    theme: "light",
    scrollX: 100,
    scrollY: 200,
    openSidebar: { name: "default" },
  }));
  a.resolve({ elements: [], revision: 1 });
  expect((await loading).ok).toBe(true);
  expect(spies.updateScene).toHaveBeenCalledTimes(1);
});

it("detects in-place element version changes during a load", async () => {
  const { api, spies, showContent } = createApiStub();
  showContent();
  const hook = mount(api);
  const a = deferredScene();
  importSceneData.mockReturnValue(a.promise);
  const loading = hook.applyRemoteScene({ sceneId: "A" });
  Object.assign(spies.getSceneElements()[0]!, { version: 2 });
  a.resolve({ elements: [], revision: 1 });
  expect(await loading).toEqual({ ok: false, reason: "canvas_changed" });
  expect(spies.updateScene).not.toHaveBeenCalled();
});
