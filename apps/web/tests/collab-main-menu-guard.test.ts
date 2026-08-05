import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Upstream's file import is the one canvas-replacement path the collaboration
 * canvas claim cannot observe.
 *
 * `MainMenu.DefaultItems.LoadScene` swaps the scene inside the engine without
 * touching Drawstuff's scene session, so the two storage writers that release the
 * claim never run. A guest in a room could then import an unrelated file, have it
 * broadcast into the room, and have the room's traffic reconcile back into it.
 *
 * The guard is structural rather than behavioural on purpose: rendering the whole
 * editor to assert the absence of a menu item would test the upstream menu, not
 * our composition, and the property that matters is simply that the item is not
 * mounted unconditionally. A future edit that drops the condition fails here.
 */

const menuSource = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../src/components/excalidraw/app-main-menu.tsx",
  ),
  "utf8",
);

describe("main menu collaboration guard", () => {
  it("withholds upstream's file import while a room owns the canvas", () => {
    expect(menuSource).toContain(
      "{!isCollaborating && <MainMenu.DefaultItems.LoadScene />}",
    );
    // Never mounted unconditionally: that is the regression this pins.
    expect(menuSource).not.toMatch(
      /^\s*<MainMenu\.DefaultItems\.LoadScene \/>\s*$/m,
    );
  });

  it("gates on canvas ownership, not on the connected status", () => {
    const editorSource = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/components/excalidraw/excalidraw-editor.tsx",
      ),
      "utf8",
    );
    // The canvas is claimed before the join token is minted and the key derived,
    // so gating on `isCollaborating` (which waits for the relay's `connected`)
    // would leave a window in which the canvas already belongs to the room while
    // the file-import item is still offered.
    expect(editorSource).toContain("ownsCanvas: isCanvasOwnedByRoom");
    expect(editorSource).toContain("isCollaborating={isCanvasOwnedByRoom}");
  });

  it("does not use the canvas claim to skip the replacement prompt", () => {
    const hookSource = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/hooks/excalidraw/use-collaboration-room.ts",
      ),
      "utf8",
    );
    // The claim is per tab; the restored canvas in localStorage is not. Another
    // tab loading an unrelated scene leaves this tab's claim pointing at a canvas
    // it no longer describes, so a reload must still ask before handing the
    // canvas to the room.
    expect(hookSource).toContain(
      "if (!isOpenScene && !(await prepareCanvas())) return;",
    );
  });
});
