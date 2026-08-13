import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mocked so the probe imports no canvas machinery; the lock has its own tests. */
vi.mock("@/lib/excalidraw", () => ({ saveData: vi.fn() }));

import type {
  AppState,
  BinaryFiles,
  OrderedExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";

import { useScenePersistence } from "@/hooks/excalidraw/use-scene-persistence";
import {
  SceneSessionProvider,
  useSceneSession,
} from "@/hooks/scene-session-context";

/**
 * Reference-counted dirty-tracking suppression (Plan 01 / A2).
 *
 * Collaboration opens two kinds of suppression window on the same context: a
 * frame-deferred one around element applies and a synchronous one around
 * presence applies. With a single boolean, any window's resume released every
 * other window still open — and with presence arriving at ~30fps per peer the
 * windows overlapped continuously, so a local edit could fall inside one for
 * the whole session and the unsaved-changes indicator never appeared. These
 * tests pin the counted semantics: a resume releases exactly one hold.
 */

type SessionContext = ReturnType<typeof useSceneSession>;
type Handlers = ReturnType<typeof useScenePersistence>;

const probe: { session?: SessionContext; handlers?: Handlers } = {};

function Probe() {
  const session = useSceneSession();
  const handlers = useScenePersistence(null);
  useEffect(() => {
    probe.session = session;
    probe.handlers = handlers;
  }, [session, handlers]);
  return null;
}

const session = (): SessionContext => {
  if (!probe.session) throw new Error("scene session probe not ready");
  return probe.session;
};

/** A local edit, as the editor's `onChange` delivers it. */
const localSceneChange = (): void => {
  probe.handlers?.handleSceneChange(
    [] as readonly OrderedExcalidrawElement[],
    { name: "scene" } as AppState,
    {} as BinaryFiles,
  );
};

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SceneSessionProvider>
        <Probe />
      </SceneSessionProvider>,
    );
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  probe.session = undefined;
  probe.handlers = undefined;
  vi.useRealTimers();
});

describe("dirty-tracking suppression holds", () => {
  it("does not let overlapping suppressors release each other", () => {
    session().suppressDirtyTracking();
    session().suppressDirtyTracking();

    session().resumeDirtyTracking();
    // One hold is still open, so tracking stays suppressed.
    expect(session().shouldSuppressDirtyTracking()).toBe(true);

    session().resumeDirtyTracking();
    expect(session().shouldSuppressDirtyTracking()).toBe(false);
  });

  it("keeps an element window open across presence windows inside it", () => {
    act(() => {
      session().syncCurrentScene({ id: "scene-1" });
    });

    // A remote element apply opens its frame-deferred window…
    session().suppressDirtyTracking();
    // …and presence applies open and close synchronous windows inside it.
    for (let burst = 0; burst < 5; burst += 1) {
      session().suppressDirtyTracking();
      session().resumeDirtyTracking();
    }
    // The element window must still be holding: a presence resume releasing it
    // is exactly how a remote write's onChange used to mark the scene dirty.
    expect(session().shouldSuppressDirtyTracking()).toBe(true);
    act(() => {
      localSceneChange();
    });
    expect(session().isDirty).toBe(false);

    // Once the element window closes, the next local edit marks dirty again.
    session().resumeDirtyTracking();
    act(() => {
      localSceneChange();
    });
    expect(session().isDirty).toBe(true);
  });

  it("does not release a caller's open hold when the scene session is cleared", () => {
    // Joining a room clears the scene session *inside* its own suppression
    // window (`prepareCanvas`); the clear releasing the window would let the
    // canvas-emptying write mark the just-cleared session dirty.
    session().suppressDirtyTracking();
    act(() => {
      session().clearCurrentScene();
    });
    expect(session().shouldSuppressDirtyTracking()).toBe(true);
    session().resumeDirtyTracking();
    expect(session().shouldSuppressDirtyTracking()).toBe(false);
  });

  it("treats an unmatched resume as a no-op", () => {
    session().resumeDirtyTracking();
    expect(session().shouldSuppressDirtyTracking()).toBe(false);

    // The unmatched resume must not have gone below zero.
    session().suppressDirtyTracking();
    expect(session().shouldSuppressDirtyTracking()).toBe(true);
    session().resumeDirtyTracking();
    expect(session().shouldSuppressDirtyTracking()).toBe(false);
  });

  it("releases every leaked hold through its own safety net", () => {
    session().suppressDirtyTracking();
    session().suppressDirtyTracking();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(session().shouldSuppressDirtyTracking()).toBe(false);
  });

  it("keeps a leaked hold's safety net intact under presence churn", () => {
    // An element window whose deferred resume never fires (a hidden tab's rAF).
    session().suppressDirtyTracking();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // Presence windows keep opening and closing while the outer hold leaks. A
    // resume that released the *oldest* hold would keep replacing the surviving
    // safety timer with an ever-newer one, so the leak would outlive any churn.
    for (let burst = 0; burst < 10; burst += 1) {
      session().suppressDirtyTracking();
      session().resumeDirtyTracking();
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }

    // 6s have passed since the leaked hold opened; its own 5s net has fired.
    expect(session().shouldSuppressDirtyTracking()).toBe(false);
  });
});
