// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});

import { EditorStorageStatus } from "@/components/excalidraw/editor-storage-status";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => act(() => root?.unmount()));

const renderStatus = (
  props: Partial<Parameters<typeof EditorStorageStatus>[0]>,
): HTMLElement => {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root?.render(
      <EditorStorageStatus
        roomId={null}
        state={{ status: "saved", revision: 1, checksum: null }}
        sourceSceneId={null}
        onRetry={() => undefined}
        onCopy={() => undefined}
        onUpdateSource={() => Promise.resolve()}
        api={null}
        isAuthenticated
        detachedFromSceneName={null}
        {...props}
      />,
    ),
  );
  return container;
};

describe("editor storage status (18C §5)", () => {
  it("labels only a detached signed-out draft, naming the scene it left", () => {
    // A personal canvas, saved or not, is the default and carries no label.
    expect(renderStatus({}).textContent).toBe("");
    expect(renderStatus({ detachedFromSceneName: "Roadmap" }).textContent).toBe(
      "Unsaved · not in “Roadmap”",
    );
  });

  it("calls a confirmed room save an encrypted snapshot", () => {
    expect(renderStatus({ roomId: "room-alpha-1" }).textContent).toContain(
      "Encrypted snapshot saved",
    );
  });
});
