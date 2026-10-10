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

const render = (belowToolbar: boolean) =>
  act(() =>
    root.render(
      <MobileRoomBadge belowToolbar={belowToolbar}>
        <span>room badge</span>
      </MobileRoomBadge>,
    ),
  );

/** The room badge stays reachable in Excalidraw's mobile layout only. */
describe("MobileRoomBadge", () => {
  it("shows the badge on mobile, below the tools in edit mode", () => {
    device.editor.isMobile = true;
    render(true);
    expect(container.textContent).toBe("room badge");
    expect(container.firstElementChild?.className).toContain("4.25rem");
    render(false);
    expect(container.firstElementChild?.className).toContain("0.75rem");
  });

  it("renders nothing in the desktop layout", () => {
    device.editor.isMobile = false;
    render(true);
    expect(container.textContent).toBe("");
  });
});
