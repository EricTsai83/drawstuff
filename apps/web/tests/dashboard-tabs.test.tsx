// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";

vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    category: {
      list: {
        useQuery: () => ({ data: [], isError: false, refetch: vi.fn() }),
      },
    },
    scene: {
      getUserScenesInfinite: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          isError: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        }),
      },
    },
  },
}));
vi.mock("@/hooks/use-workspace-options", () => ({
  useWorkspaceOptions: () => ({
    workspaces: [],
    lastActiveWorkspaceId: undefined,
    isLoading: false,
  }),
}));
vi.mock("@/components/route-overlay-context", () => ({
  useIsInRouteOverlay: () => false,
}));
const { roomListMounts } = vi.hoisted(() => ({ roomListMounts: vi.fn() }));
vi.mock("@/components/collaboration-room-list", async () => {
  const { useEffect } = await import("react");
  return {
    CollaborationRoomList: () => {
      useEffect(() => {
        roomListMounts();
      }, []);
      return <div data-testid="room-list" />;
    },
  };
});
vi.mock("@/components/excalidraw/workspace-selector", () => ({
  WorkspaceSelector: () => <div data-testid="workspace-selector" />,
}));
vi.mock("@/components/category-management-dialog", () => ({
  CategoryManagementDialog: () => null,
}));

import { SceneSearchList } from "@/components/scene-search-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
const render = (searchParams: string) =>
  act(() =>
    root.render(
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        <SceneSearchList />
      </NuqsTestingAdapter>,
    ),
  );
/** Inactive panels stay mounted but hidden. */
const visible = (testId: string) => {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  return !!element && !element.closest("[hidden]");
};
const tab = (name: string) =>
  Array.from(container.querySelectorAll('[role="tab"]')).find(
    (element) => element.textContent === name,
  ) as HTMLElement | undefined;

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onUrlUpdate.mockClear();
  roomListMounts.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("dashboard tabs", () => {
  it("opens on personal scenes with their workspace and filters", () => {
    render("");
    expect(tab("My scenes")?.getAttribute("aria-selected")).toBe("true");
    expect(visible("workspace-selector")).toBe(true);
    expect(visible("room-list")).toBe(false);
  });

  it("shows only the room list on the rooms tab", () => {
    render("?view=rooms");
    expect(tab("Rooms")?.getAttribute("aria-selected")).toBe("true");
    expect(visible("room-list")).toBe(true);
    // Workspaces, search and filters belong to scenes only.
    expect(visible("workspace-selector")).toBe(false);
    expect(
      Array.from(container.querySelectorAll("input")).every((input) =>
        input.closest("[hidden]"),
      ),
    ).toBe(true);
  });

  it("keeps the tab in the URL and drops it again for the default", async () => {
    render("");
    await act(async () => tab("Rooms")?.click());
    await vi.waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.lastCall?.[0].searchParams.get("view")).toBe(
      "rooms",
    );
    await act(async () => tab("My scenes")?.click());
    await vi.waitFor(() =>
      expect(onUrlUpdate.mock.lastCall?.[0].searchParams.has("view")).toBe(
        false,
      ),
    );
  });

  it("keeps both panels mounted across switches", async () => {
    // Scene pagination keeps observing the same sentinel, and room
    // management keeps its retained intents, only if nothing remounts.
    render("");
    const selector = container.querySelector(
      '[data-testid="workspace-selector"]',
    );
    await act(async () => tab("Rooms")?.click());
    await act(async () => tab("My scenes")?.click());
    await act(async () => tab("Rooms")?.click());
    expect(container.querySelector('[data-testid="workspace-selector"]')).toBe(
      selector,
    );
    expect(roomListMounts).toHaveBeenCalledOnce();
  });
});

describe("dashboard scenes empty state", () => {
  it("welcomes a new account with a way to the editor", () => {
    render("");
    expect(container.textContent).toContain("No scenes yet");
    expect(container.textContent).not.toContain("No scenes found");
    expect(container.textContent).not.toContain("Recently modified by you");
    const link = Array.from(container.querySelectorAll("a")).find(
      (element) => element.textContent === "Open the editor",
    );
    expect(link?.getAttribute("href")).toBe("/");
  });

  it("says a search matched nothing, without the onboarding action", () => {
    render("?search=zzz");
    expect(container.textContent).toContain("No scenes found");
    expect(container.textContent).not.toContain("Open the editor");
  });
});
