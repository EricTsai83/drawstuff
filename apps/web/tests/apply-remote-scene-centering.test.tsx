import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExcalidrawElement,
  ExcalidrawImperativeAPI,
} from "@drawstuff/excalidraw-adapter/types";

const { importSceneData, importSceneFiles, session } = vi.hoisted(() => ({
  importSceneData: vi.fn(),
  importSceneFiles: vi.fn(),
  session: {
    suppressDirtyTracking: vi.fn(),
    resumeDirtyTracking: vi.fn(),
    syncCurrentScene: vi.fn(),
  },
}));

vi.mock("@/lib/import-data-from-db", () => ({
  importSceneDataBySceneId: importSceneData,
  importSceneFilesBySceneId: importSceneFiles,
}));

/** Mocked so the hook imports no canvas machinery; hydration has its own tests. */
vi.mock("@/lib/excalidraw", () => ({
  hasCompleteSceneFileHydration: () => true,
  saveToLocalStorage: vi.fn(),
}));

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => session,
}));

import { useApplyRemoteScene } from "@/hooks/excalidraw/use-apply-remote-scene";

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
    getAppState: () => ({ theme: "light" }),
    updateScene: vi.fn(),
    getSceneElements: vi.fn(() => scene.elements),
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
