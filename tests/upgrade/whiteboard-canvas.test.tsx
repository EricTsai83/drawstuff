import { StrictMode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type * as ExcalidrawModule from "@excalidraw/excalidraw";
import type { WhiteboardEngine } from "@/features/whiteboard";

const canvasMocks = vi.hoisted(() => ({
  changeListeners: [] as Array<
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => void
  >,
  unsubscribeScroll: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", async (importOriginal) => {
  const actual = await importOriginal<typeof ExcalidrawModule>();
  const React = await import("react");
  const appState = {
    name: "Strict Mode scene",
    theme: "light",
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    width: 1000,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    activeTool: { type: "selection", locked: false, customType: null },
    selectedElementIds: {},
  } as unknown as AppState;
  const api = {
    getSceneElements: () => [],
    getSceneElementsIncludingDeleted: () => [],
    getAppState: () => appState,
    getFiles: () => ({}),
    getName: () => "Strict Mode scene",
    onChange: (
      listener: (
        elements: readonly ExcalidrawElement[],
        state: AppState,
        files: BinaryFiles,
      ) => void,
    ) => {
      canvasMocks.changeListeners.push(listener);
      return () => {
        const index = canvasMocks.changeListeners.indexOf(listener);
        if (index >= 0) {
          canvasMocks.changeListeners.splice(index, 1);
        }
      };
    },
    onScrollChange: () => canvasMocks.unsubscribeScroll,
  } as unknown as ExcalidrawImperativeAPI;

  function MockExcalidraw({ excalidrawAPI }: ExcalidrawProps) {
    React.useEffect(() => {
      if (typeof excalidrawAPI === "function") {
        excalidrawAPI(api);
      }
    }, [excalidrawAPI]);
    return React.createElement("div", {
      className: "excalidraw-container",
    });
  }

  return { ...actual, Excalidraw: MockExcalidraw };
});

import { ExcalidrawCanvas } from "@/features/whiteboard/adapters/excalidraw";

describe("ExcalidrawCanvas lifecycle", () => {
  it("keeps a live engine after the Strict Mode effect replay and destroys it on unmount", async () => {
    const onEngineReady = vi.fn<(engine: WhiteboardEngine | null) => void>();
    const view = render(
      <StrictMode>
        <ExcalidrawCanvas onEngineReady={onEngineReady} />
      </StrictMode>,
    );

    await waitFor(() => {
      const latestEngine = onEngineReady.mock.calls.at(-1)?.[0];
      expect(latestEngine).not.toBeNull();
      expect(() => latestEngine?.getDocument()).not.toThrow();
    });

    const latestEngine = onEngineReady.mock.calls.at(-1)?.[0];
    const onDocument = vi.fn();
    latestEngine?.subscribeDocument(onDocument);
    for (const listener of [...canvasMocks.changeListeners]) {
      listener([], appStateForEvent(), {});
    }
    expect(onDocument).toHaveBeenCalledOnce();

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onEngineReady.mock.calls.at(-1)?.[0]).toBeNull();
    expect(canvasMocks.changeListeners).toHaveLength(0);
  });
});

function appStateForEvent(): AppState {
  return {
    name: "Strict Mode scene",
    theme: "light",
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    width: 1000,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    activeTool: { type: "selection", locked: false, customType: null },
    selectedElementIds: {},
  } as unknown as AppState;
}
