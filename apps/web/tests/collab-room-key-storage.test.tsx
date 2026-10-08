// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { roomKeySchema } from "@drawstuff/collaboration/realtime-crypto";

import { useCollaborationRoomKey } from "@/hooks/excalidraw/use-collaboration-room-key";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_KEY = roomKeySchema.parse(
  "d2ViLXRlc3Qtcm9vbS1rZXktMzItYnl0ZXMtMDAwMDA",
);

/** Every web-storage value and cookie the page could read back later. */
const persistedBrowserState = (): string =>
  [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? "";
        return `${key}=${storage.getItem(key)}`;
      }),
    )
    .concat(document.cookie)
    .join("\n");

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  window.history.replaceState(null, "", "/");
});

describe("room key browser storage (18C §3)", () => {
  it("keeps the key in the URL fragment only, never in web storage or cookies", () => {
    const setters: Array<(key: typeof ROOM_KEY | null) => void> = [];
    function Probe() {
      const [, setKey] = useCollaborationRoomKey();
      useEffect(() => {
        setters.push(setKey);
      }, [setKey]);
      return null;
    }
    window.history.replaceState(null, "", "/?collab-room=room-a");
    root = createRoot(document.createElement("div"));
    act(() => root?.render(<Probe />));
    const setKey = setters[0];

    act(() => setKey?.(ROOM_KEY));
    expect(window.location.hash).toContain(ROOM_KEY);
    expect(persistedBrowserState()).not.toContain(ROOM_KEY);

    act(() => setKey?.(null));
    expect(window.location.hash).toBe("");
    expect(persistedBrowserState()).not.toContain(ROOM_KEY);
  });
});
