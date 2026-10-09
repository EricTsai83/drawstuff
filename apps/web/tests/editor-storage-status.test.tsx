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

  it("reports a confirmed room save in the panel", () => {
    const panel = renderStatus({ roomId: "room-alpha-1" });
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("Saved");
    expect(panel.textContent).toContain("Save a copy to my scenes");
  });

  it("marks a confirmed save on the badge briefly, without changing its width", () => {
    vi.useFakeTimers();
    try {
      const container = renderStatus({ roomId: "room-alpha-1", compact: true });
      const badge = () => container.querySelector("button");
      const icon = () => badge()?.querySelector("[data-status]");
      const text = badge()?.textContent;
      expect(icon()?.getAttribute("data-status")).toBe("saved");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(icon()?.getAttribute("data-status")).toBe("settled");
      // Only the fixed-size icon changes; the label text never does.
      expect(badge()?.textContent).toBe(text);
      expect(badge()?.getAttribute("title")).toBe("Saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the lock, not a pending dot, before a joined room is confirmed", () => {
    const container = renderStatus({
      roomId: "room-alpha-1",
      compact: true,
      state: { status: "pending", revision: null, checksum: null },
    });
    expect(
      container.querySelector("[data-status]")?.getAttribute("data-status"),
    ).toBe("settled");
  });

  it("keeps a failed save on the badge until it resolves", () => {
    vi.useFakeTimers();
    try {
      const container = renderStatus({
        roomId: "room-alpha-1",
        compact: true,
        state: { status: "failed", revision: 1, checksum: null },
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      const badge = container.querySelector("button");
      expect(
        badge?.querySelector("[data-status]")?.getAttribute("data-status"),
      ).toBe("failed");
      expect(badge?.getAttribute("aria-label")).toContain("Save failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
