// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterInputs, RouterOutputs } from "@/trpc/react";

const { listQuery, refetch, select } = vi.hoisted(() => ({
  listQuery: vi.fn<(input: RouterInputs["admin"]["listRooms"]) => unknown>(),
  refetch: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/trpc/react", () => ({
  api: { admin: { listRooms: { useQuery: listQuery } } },
}));
vi.mock("@/hooks/use-app-i18n", () => ({
  useAppI18n: () => ({ langCode: "en" }),
}));

import { AdminRoomList } from "@/components/admin/admin-room-list";

type Result = RouterOutputs["admin"]["listRooms"];
const room: Result["rooms"][number] = {
  roomId: "6ff9aa6e-a475-418f-bbba-91d89cc7b8e8",
  label: "Team board",
  status: "ready",
  createdAt: new Date("2026-10-10T10:00:00Z"),
  ownerName: "Owner",
  ownerEmail: "owner@example.com",
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  data: Result | undefined,
  overrides: { isError?: boolean; isPending?: boolean } = {},
) {
  listQuery.mockReturnValue({
    data,
    isSuccess: !overrides.isError && !overrides.isPending,
    isFetching: false,
    isPending: false,
    isError: false,
    refetch,
    ...overrides,
  });
  act(() =>
    root.render(<AdminRoomList selectedRoomId={null} onSelect={select} />),
  );
}
function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}

describe("admin room inventory", () => {
  it("shows rooms without knowing an ID and selects the full room ID", () => {
    render({ rooms: [room], nextCursor: null });
    expect(container.textContent).toContain("Team board");
    expect(container.textContent).toContain("owner@example.com");
    expect(container.textContent).toContain(room.roomId);
    click("View details");
    expect(select).toHaveBeenCalledWith(room.roomId);
    click("Refresh");
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("distinguishes a failed load from an empty inventory and preserves cached rows", () => {
    render(undefined, { isError: true });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load",
    );
    expect(container.textContent).not.toContain("No active rooms");
    render({ rooms: [room], nextCursor: null }, { isError: true });
    expect(container.textContent).toContain("Team board");
    render({ rooms: [], nextCursor: null });
    expect(container.textContent).toContain("No active rooms");
  });

  it("uses the returned cursor for the next page and can return to the first", () => {
    const cursor = { createdAt: room.createdAt, roomId: room.roomId };
    render({ rooms: [room], nextCursor: cursor });
    click("Next page");
    expect(listQuery).toHaveBeenLastCalledWith(
      { limit: 25, cursor },
      { staleTime: 0 },
    );
    click("First page");
    expect(listQuery).toHaveBeenLastCalledWith(
      {
        limit: 25,
        cursor: undefined,
      },
      { staleTime: 0 },
    );
  });
});
