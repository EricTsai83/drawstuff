// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ editor: { isMobile: true } }));
vi.mock("@drawstuff/excalidraw-adapter/client", () => ({
  useExcalidrawDevice: () => device,
}));

const { MobileRoomBadge } =
  await import("@/components/excalidraw/mobile-room-badge");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  host = document.createElement("div");
  host.className = "excalidraw";
  document.body.appendChild(host);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(() =>
    root.render(
      <MobileRoomBadge>
        <span>room</span>
      </MobileRoomBadge>,
    ),
  );
const position = () => (container.firstElementChild as HTMLElement).style;

/** The room button stays reachable in Excalidraw's mobile layout only. */
describe("MobileRoomBadge", () => {
  it("sits right under upstream's mobile tools column", () => {
    device.editor.isMobile = true;
    const column = document.createElement("div");
    column.className = "mobile-misc-tools-container";
    column.getBoundingClientRect = () =>
      ({ bottom: 200, right: window.innerWidth }) as DOMRect;
    host.appendChild(column);
    render();
    expect(container.textContent).toBe("room");
    expect(position().top).toBe("208px");
    expect(position().right).toBe("8px");
  });

  it("takes the top-right corner when there is no tools column", () => {
    device.editor.isMobile = true;
    render();
    expect(position().top).toContain("0.75rem");
    expect(position().right).toContain("0.75rem");
  });

  it("renders nothing in the desktop layout", () => {
    device.editor.isMobile = false;
    render();
    expect(container.textContent).toBe("");
  });
});
