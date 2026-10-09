// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "@/hooks/excalidraw/use-signed-out-draft";
import { useSignedOutRoomPrompt } from "@/hooks/excalidraw/use-signed-out-room-prompt";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openDialog = vi.fn();

function Probe(props: { authState: AuthState; roomId: string | null }) {
  useSignedOutRoomPrompt({ ...props, openDialog });
  return null;
}

let root: Root;
const render = (authState: AuthState, roomId: string | null) =>
  act(() => root.render(<Probe authState={authState} roomId={roomId} />));

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  openDialog.mockClear();
});
afterEach(() => act(() => root.unmount()));

describe("signed-out room link prompt", () => {
  it("opens the dialog once when a room link is opened signed out", () => {
    render("unknown", "room-a");
    expect(openDialog).not.toHaveBeenCalled();
    render("signed-out", "room-a");
    render("signed-out", "room-a");
    expect(openDialog).toHaveBeenCalledOnce();
    // Another room is a new link and earns its own prompt.
    render("signed-out", "room-b");
    expect(openDialog).toHaveBeenCalledTimes(2);
  });

  it("stays closed for signed-in people and personal canvases", () => {
    render("signed-in", "room-a");
    render("signed-out", null);
    expect(openDialog).not.toHaveBeenCalled();
  });
});
