// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});

import { SignedOutDraftDialog } from "@/components/excalidraw/signed-out-draft-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const renderDialog = (detachedFromSceneName: string | null) => {
  const onChoose = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SignedOutDraftDialog
        open
        detachedFromSceneName={detachedFromSceneName}
        onChoose={onChoose}
      />,
    ),
  );
  return onChoose;
};

const button = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );

describe("SignedOutDraftDialog", () => {
  it("names the scene the changes are not in", () => {
    renderDialog("Roadmap");
    expect(document.body.textContent).toContain(
      "these changes are not in “Roadmap”",
    );
  });

  it("offers save, keep, and discard, but never updating the original", () => {
    const onChoose = renderDialog(null);
    expect(document.body.textContent).toContain(
      "isn't part of any of your saved scenes",
    );
    for (const [label, choice] of [
      ["Save as new scene", "save"],
      ["Keep editing without saving", "keep"],
      ["Discard", "discard"],
    ] as const) {
      act(() => button(label)?.click());
      expect(onChoose).toHaveBeenLastCalledWith(choice);
    }
    expect(onChoose).toHaveBeenCalledTimes(3);
    expect(document.body.querySelectorAll("button")).toHaveLength(3);
  });
});
