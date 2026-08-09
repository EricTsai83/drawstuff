import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/excalidraw", () => ({
  cleanUnusedFiles: vi.fn((_elements: unknown, files: unknown) => files),
  saveToLocalStorage: vi.fn(),
}));

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import {
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";
import { useBeforeUnload } from "@/hooks/excalidraw/use-before-unload";
import { saveToLocalStorage } from "@/lib/excalidraw";

const saveToLocalStorageMock = vi.mocked(saveToLocalStorage);
const excalidrawAPI = {
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
} as unknown as ExcalidrawImperativeAPI;

function Probe() {
  useBeforeUnload(excalidrawAPI);
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  resumeLocalScenePersistence("sign-out");
  saveToLocalStorageMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resumeLocalScenePersistence("sign-out");
});

describe("sign-out beforeunload guard", () => {
  it("normally caches the current canvas on unload", () => {
    window.dispatchEvent(new Event("beforeunload"));
    expect(saveToLocalStorageMock).toHaveBeenCalledTimes(1);
  });

  it("does not write the cleared canvas cache back during sign-out", () => {
    pauseLocalScenePersistence("sign-out");
    window.dispatchEvent(new Event("beforeunload"));
    expect(saveToLocalStorageMock).not.toHaveBeenCalled();
  });
});
