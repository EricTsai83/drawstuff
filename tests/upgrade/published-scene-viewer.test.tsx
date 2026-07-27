import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OwnedWhiteboardDocument,
  WhiteboardViewerController,
} from "@/features/whiteboard";

const mocks = vi.hoisted(() => ({
  activeTheme: "light",
  documents: [] as OwnedWhiteboardDocument[],
  fitToContent: vi.fn(),
  getViewport: vi.fn(() => ({
    x: 0,
    y: 0,
    zoom: 1,
    width: 800,
    height: 600,
    offsetX: 0,
    offsetY: 0,
  })),
  loadPublishedSceneData: vi.fn(),
  requestFullscreen: vi.fn(async () => undefined),
  setTheme: vi.fn(),
  updateViewport: vi.fn(),
}));

vi.mock("@/lib/published-scene-data", () => ({
  loadPublishedSceneData: mocks.loadPublishedSceneData,
}));

vi.mock("@/hooks/use-sync-theme", () => ({
  useSyncTheme: () => ({
    browserActiveTheme: mocks.activeTheme,
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/hooks/use-standalone-i18n", () => ({
  useStandaloneI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/whiteboard/owned", async () => {
  const React = await import("react");
  return {
    OwnedWhiteboardCanvas: ({
      document,
      editingEnabled,
      onDocumentReady,
      onViewerReady,
    }: {
      readonly document: OwnedWhiteboardDocument;
      readonly editingEnabled: boolean;
      readonly onDocumentReady: () => void;
      readonly onViewerReady: (
        controller: WhiteboardViewerController | null,
      ) => void;
    }) => {
      mocks.documents.push(document);
      React.useEffect(() => {
        const controller: WhiteboardViewerController = {
          fitToContent: mocks.fitToContent,
          getViewport: mocks.getViewport,
          subscribeViewport: () => () => undefined,
          updateViewport: mocks.updateViewport,
        };
        onViewerReady(controller);
        onDocumentReady();
        return () => onViewerReady(null);
      }, [onDocumentReady, onViewerReady]);
      return (
        <div
          data-editing-enabled={String(editingEnabled)}
          data-testid="owned-viewer-canvas"
        />
      );
    },
  };
});

import { PublishedSceneViewer } from "@/components/whiteboard/published-scene-viewer";

const DOCUMENT: OwnedWhiteboardDocument = {
  elements: [
    {
      id: "published-shape",
      type: "rectangle",
      isDeleted: false,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      opacity: 100,
      roughness: 1,
      locked: false,
    },
  ],
  assets: {},
  state: {
    name: "Published",
    theme: "light",
    viewBackgroundColor: "#ffffff",
    gridSize: null,
  },
};

describe("published owned scene viewer", () => {
  beforeEach(() => {
    mocks.activeTheme = "light";
    mocks.documents.length = 0;
    mocks.setTheme.mockImplementation((theme: "dark" | "light") => {
      mocks.activeTheme = theme;
    });
    mocks.loadPublishedSceneData.mockResolvedValue(DOCUMENT);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: mocks.requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn(async () => undefined),
    });
  });

  it("loads the owned canvas with navigation, theme, and fullscreen controls", async () => {
    renderViewer();

    const canvas = await screen.findByTestId("owned-viewer-canvas");
    expect(canvas.dataset.editingEnabled).toBe("false");
    const toolbar = screen.getByRole("toolbar", { name: "Viewer controls" });
    fireEvent.click(
      within(toolbar).getByRole("button", {
        name: "public.viewer.zoomIn",
      }),
    );
    expect(mocks.updateViewport).toHaveBeenCalledWith({
      x: -66.66666666666663,
      y: -50,
      zoom: 1.2,
    });

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "public.viewer.fit" }),
    );
    expect(mocks.fitToContent).toHaveBeenCalledWith({
      fitToViewport: true,
      viewportZoomFactor: 0.7,
    });

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "public.theme.light" }),
    );
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Enter fullscreen" }),
    );
    expect(mocks.requestFullscreen).toHaveBeenCalled();
  });

  it("preserves a visible published-scene load error", async () => {
    mocks.loadPublishedSceneData.mockRejectedValueOnce(new Error("bad scene"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderViewer();

    await waitFor(() =>
      expect(screen.getByText("public.viewer.loadError")).not.toBeNull(),
    );
    expect(screen.queryByTestId("owned-viewer-canvas")).toBeNull();
  });

  it("changes viewer chrome theme without reloading the canvas document", async () => {
    const view = renderViewer();
    await screen.findByTestId("owned-viewer-canvas");
    const initialDocument = mocks.documents.at(-1);

    fireEvent.click(screen.getByRole("button", { name: "public.theme.light" }));
    view.rerender(viewerElement());

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "public.theme.dark" }),
      ).not.toBeNull(),
    );
    expect(mocks.documents.at(-1)).toBe(initialDocument);
  });
});

function renderViewer() {
  return render(viewerElement());
}

function viewerElement() {
  return (
    <PublishedSceneViewer
      authorName="Author"
      fileRecords={[]}
      sceneData="compressed"
      sceneDescription="Description"
      sceneName="Public board"
      updatedAt="2026-07-27T00:00:00.000Z"
    />
  );
}
