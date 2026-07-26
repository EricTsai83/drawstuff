import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WhiteboardDocument,
  WhiteboardEngine,
} from "@/features/whiteboard";

const persistenceMocks = vi.hoisted(() => ({
  currentSceneId: undefined as string | undefined,
  markCurrentSceneDirty: vi.fn(),
  shouldSuppressDirtyTracking: vi.fn(() => false),
  debouncedSave: vi.fn(),
}));

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => ({
    currentSceneId: persistenceMocks.currentSceneId,
    markCurrentSceneDirty: persistenceMocks.markCurrentSceneDirty,
    shouldSuppressDirtyTracking: persistenceMocks.shouldSuppressDirtyTracking,
  }),
}));

vi.mock("@/hooks/use-debounce", () => ({
  useDebounce: () => [persistenceMocks.debouncedSave],
}));

vi.mock("@/lib/excalidraw", () => ({
  saveData: vi.fn(),
}));

import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";

const document: WhiteboardDocument = {
  elements: [],
  state: { name: "Persisted scene", theme: "light" },
  assets: {},
};

describe("whiteboard persistence subscription", () => {
  beforeEach(() => {
    persistenceMocks.currentSceneId = undefined;
    persistenceMocks.markCurrentSceneDirty.mockReset();
    persistenceMocks.shouldSuppressDirtyTracking.mockReset();
    persistenceMocks.shouldSuppressDirtyTracking.mockReturnValue(false);
    persistenceMocks.debouncedSave.mockReset();
  });

  it("does not resubscribe and replay when the current scene id changes", async () => {
    let listener: ((nextDocument: WhiteboardDocument) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribeDocument = vi.fn(
      (nextListener: (nextDocument: WhiteboardDocument) => void) => {
        listener = nextListener;
        nextListener(document);
        return unsubscribe;
      },
    );
    const engine = {
      getEditorState: () => ({
        name: "Persisted scene",
      }),
      subscribeDocument,
      updateEditorState: vi.fn(),
    } as unknown as WhiteboardEngine;
    const hook = renderHook(() => useScenePersistence(engine));

    await waitFor(() => expect(subscribeDocument).toHaveBeenCalledOnce());
    expect(persistenceMocks.markCurrentSceneDirty).not.toHaveBeenCalled();

    persistenceMocks.currentSceneId = "scene-1";
    hook.rerender();

    expect(subscribeDocument).toHaveBeenCalledOnce();
    expect(persistenceMocks.markCurrentSceneDirty).not.toHaveBeenCalled();

    act(() => listener?.(document));
    expect(persistenceMocks.markCurrentSceneDirty).toHaveBeenCalledOnce();

    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
