// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SceneRemoteConflictDialog } from "@/components/excalidraw/scene-remote-conflict-dialog";
import { I18nProvider } from "@/hooks/i18n-context";
import { en } from "@/lib/i18n/en";

it("a room source conflict offers a named copy or continued collaboration without remote hydration", () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const choose = vi.fn();
  try {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en" initialDictionary={en}>
          <SceneRemoteConflictDialog
            open
            roomSource
            onOpenChange={() => undefined}
            onChoose={choose}
          />
        </I18nProvider>,
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
    expect(buttons).toHaveLength(2);
    expect(dialog?.textContent).toContain(en["storage.copyNotice"]);
    expect(dialog?.textContent).not.toContain(en["scene.conflict.load.title"]);
    act(() => buttons[0]?.click());
    expect(choose).toHaveBeenLastCalledWith("saveAsNew");
    act(() => buttons[1]?.click());
    expect(choose).toHaveBeenLastCalledWith("keepLocal");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
