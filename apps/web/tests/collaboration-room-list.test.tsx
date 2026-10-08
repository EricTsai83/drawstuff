// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listQuery, push, refetch } = vi.hoisted(() => ({
  listQuery: vi.fn<() => unknown>(),
  push: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    collaborationRoom: { list: { useQuery: listQuery } },
  },
}));

import { CollaborationRoomList } from "@/components/collaboration-room-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const render = (query: Record<string, unknown>) => {
  listQuery.mockReturnValue({
    isPending: false,
    isError: false,
    refetch,
    ...query,
  });
  act(() => root.render(<CollaborationRoomList />));
};

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  push.mockClear();
  refetch.mockClear();
});
afterEach(() => act(() => root.unmount()));

describe("collaboration room list (18C §2)", () => {
  it("reports a failed query with retry instead of an empty list", () => {
    render({ isError: true });
    expect(container.textContent).toContain("Could not load your rooms");
    expect(container.textContent).not.toContain("no collaboration rooms yet");
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry")
        ?.click(),
    );
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("never shows cached empty data as empty after a failed refetch", () => {
    render({ isError: true, data: { rooms: [], nextCursor: null } });
    expect(container.textContent).toContain("Could not load your rooms");
    expect(container.textContent).not.toContain("no collaboration rooms yet");
  });

  it("distinguishes loading from an empty result", () => {
    render({ isPending: true });
    expect(container.textContent).toContain("Loading rooms...");
    expect(container.textContent).not.toContain("no collaboration rooms yet");
    render({ isSuccess: true, data: { rooms: [], nextCursor: null } });
    expect(container.textContent).toContain(
      "You have no collaboration rooms yet.",
    );
  });

  it("shows independent rooms with role and opens them without a key", () => {
    render({
      data: {
        rooms: [
          {
            roomId: "room-a",
            label: "",
            sceneId: null,
            status: "ready",
            role: "owner",
            listedAt: 2,
            projectionVersion: 1,
          },
          {
            roomId: "room-b",
            label: "Team board",
            sceneId: "scene-1",
            status: "initializing",
            role: "viewer",
            listedAt: 1,
            projectionVersion: 1,
          },
        ],
        nextCursor: null,
      },
    });
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows[0]?.textContent).toContain("room-a");
    expect(rows[0]?.textContent).toContain("Independent room");
    expect(rows[0]?.textContent).toContain("Owner");
    expect(rows[1]?.textContent).toContain("Team board");
    expect(rows[1]?.textContent).toContain("Linked to a personal scene");
    expect(rows[1]?.textContent).toContain("View only");

    act(() => rows[0]?.querySelector("button")?.click());
    const target = String(push.mock.calls[0]?.[0]);
    expect(new URL(target).searchParams.get("collab-room")).toBe("room-a");
    expect(new URL(target).hash).toBe("");
  });
});
