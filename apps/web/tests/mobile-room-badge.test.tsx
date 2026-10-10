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

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const render = (toolsColumnButtons: number | null) =>
  act(() =>
    root.render(
      <MobileRoomBadge toolsColumnButtons={toolsColumnButtons}>
        <span>room</span>
      </MobileRoomBadge>,
    ),
  );
const top = () => (container.firstElementChild as HTMLElement).style.top;

/** The room button stays reachable in Excalidraw's mobile layout only. */
describe("MobileRoomBadge", () => {
  it("sits right under upstream's tools column, lower when it grows", () => {
    device.editor.isMobile = true;
    render(3);
    expect(container.textContent).toBe("room");
    expect(top()).toContain("11.5rem");
    render(4);
    expect(top()).toContain("13.5rem");
  });

  it("takes the top-right corner when there is no tools column", () => {
    device.editor.isMobile = true;
    render(null);
    expect(top()).toContain("0.75rem");
  });

  it("renders nothing in the desktop layout", () => {
    device.editor.isMobile = false;
    render(3);
    expect(container.textContent).toBe("");
  });
});
