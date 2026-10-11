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
        state={{ status: "saved", revision: 1, checksum: null, localSaves: 0 }}
        sourceSceneId={null}
        onCopy={() => undefined}
        onUpdateSource={() => Promise.resolve()}
        onExit={() => undefined}
        api={null}
        isAuthenticated
        detachedFromSceneName={null}
        showSaveStatus
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

  it("keeps saying Saved once this client has saved during the visit", () => {
    const container = renderStatus({
      roomId: "room-alpha-1",
      state: { status: "saved", revision: 3, checksum: null, localSaves: 1 },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Saved",
    );
  });

  it("keeps save status off the canvas button; only the panel shows it", () => {
    for (const status of ["pending", "saving", "saved", "failed"] as const) {
      const container = renderStatus({
        roomId: "room-alpha-1",
        roomLabel: "Roadmap",
        compact: true,
        state: { status, revision: 1, checksum: null, localSaves: 1 },
      });
      const badge = container.querySelector("button");
      expect(badge?.getAttribute("aria-label")).toBe("Roadmap");
      expect(badge?.querySelector("svg.animate-spin")).toBeNull();
      act(() => root?.unmount());
    }
  });

  it("says nothing about saving before anything has changed", () => {
    const container = renderStatus({
      roomId: "room-alpha-1",
      state: { status: "idle", revision: null, checksum: null, localSaves: 0 },
    });
    expect(container.textContent).not.toContain("not saved");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("names unsaved changes once there are some", () => {
    const container = renderStatus({
      roomId: "room-alpha-1",
      state: {
        status: "pending",
        revision: null,
        checksum: null,
        localSaves: 0,
      },
    });
    expect(container.textContent).toContain("Changes not saved yet");
  });

  it("offers a way back to the personal canvas from the room panel", () => {
    const onExit = vi.fn();
    const container = renderStatus({ roomId: "room-alpha-1", onExit });
    const exit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Back to my canvas"),
    );
    act(() => exit?.click());
    expect(onExit).toHaveBeenCalledOnce();
  });
});
