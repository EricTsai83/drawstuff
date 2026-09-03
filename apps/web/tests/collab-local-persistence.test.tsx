import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `saveData` is the single entry point for caching the canvas in browser
 * storage. Mocked here so the assertion is "was the canvas cached?" rather than
 * "what ended up in localStorage", which is what the lock actually governs.
 */
vi.mock("@/lib/excalidraw", () => ({ saveData: vi.fn() }));

import type {
  AppState,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import {
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";
import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import { SceneSessionProvider } from "@/hooks/scene-session-context";
import { saveData } from "@/lib/excalidraw";

const saveDataMock = vi.mocked(saveData);

/**
 * Behavioural coverage for the persistence lock: upstream pauses local caching
 * for the whole collaboration session, and Drawstuff engages the same mechanism
 * for a guest's room canvas. What matters is that a paused canvas is never
 * written, including a write that was already queued when the pause began.
 */

type Handlers = ReturnType<typeof useScenePersistence>;

/** Publishing the hook's result from an effect keeps `Probe`'s render pure. */
const probe: { handlers?: Handlers } = {};

function Probe({ onReady }: { onReady: (handlers: Handlers) => void }) {
  const handlers = useScenePersistence(null);
  useEffect(() => {
    onReady(handlers);
  }, [handlers, onReady]);
  return null;
}

const sceneChange = (): void => {
  probe.handlers?.handleSceneChange(
    [] as readonly OrderedExcalidrawElement[],
    { name: "scene" } as AppState,
    {},
  );
};

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  saveDataMock.mockClear();
  resumeLocalScenePersistence("collaboration-guest-canvas");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SceneSessionProvider>
        <Probe
          onReady={(ready) => {
            probe.handlers = ready;
          }}
        />
      </SceneSessionProvider>,
    );
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  probe.handlers = undefined;
  vi.useRealTimers();
});

describe("local scene persistence under the collaboration lock", () => {
  it("caches the canvas while nothing holds the lock", () => {
    act(() => {
      sceneChange();
      vi.advanceTimersByTime(400);
    });
    expect(saveDataMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache the canvas while the lock is held", () => {
    pauseLocalScenePersistence("collaboration-guest-canvas");
    act(() => {
      sceneChange();
      vi.advanceTimersByTime(400);
    });
    // A guest's canvas is another user's room content with no owned scene to
    // cache it for, so it must not reach this machine's storage.
    expect(saveDataMock).not.toHaveBeenCalled();
  });

  it("cancels a save that was already queued when the lock was taken", () => {
    act(() => {
      sceneChange(); // queues a debounced save
    });
    pauseLocalScenePersistence("collaboration-guest-canvas");
    act(() => {
      sceneChange(); // the pause is observed here and cancels the queued save
      vi.advanceTimersByTime(400);
    });
    expect(saveDataMock).not.toHaveBeenCalled();
  });

  it("resumes caching once the lock is released", () => {
    pauseLocalScenePersistence("collaboration-guest-canvas");
    act(() => {
      sceneChange();
      vi.advanceTimersByTime(400);
    });
    expect(saveDataMock).not.toHaveBeenCalled();

    resumeLocalScenePersistence("collaboration-guest-canvas");
    act(() => {
      sceneChange();
      vi.advanceTimersByTime(400);
    });
    expect(saveDataMock).toHaveBeenCalledTimes(1);
  });
});
