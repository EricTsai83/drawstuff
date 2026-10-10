// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listQuery, push, refetch, execute, invalidate, toast } = vi.hoisted(
  () => ({
    listQuery: vi.fn<(input: { section: "mine" | "link" }) => unknown>(),
    push: vi.fn(),
    refetch: vi.fn(),
    // Room confirms every management intent at once in these tests.
    execute: vi.fn((input: { operationId: string }) =>
      Promise.resolve({
        operationId: input.operationId,
        status: "enforced",
        authRevision: 2,
        authorityEpoch: 1,
        projectionPending: false,
      }),
    ),
    invalidate: vi.fn(() => Promise.resolve()),
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  }),
);

// The in-session creation this list may be retrying.
const { creation } = vi.hoisted(() => ({
  creation: {
    roomId: "87f19732-2ffa-4fbe-8456-7c221487594f",
    start: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  },
}));
vi.mock("@/lib/collab/room-initialization", () => ({
  INITIALIZATION_SETTLE_MS: 15_000,
  createRoomInitialization: () => creation,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});
vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      client: {
        collaborationAuthority: {
          execute: { mutate: execute },
        },
      },
      collaborationRoom: { list: { invalidate } },
    }),
    collaborationRoom: { list: { useQuery: listQuery } },
  },
}));

import { CollaborationRoomList } from "@/components/collaboration-room-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Query = Record<string, unknown>;
const empty = { isSuccess: true, data: { rooms: [], nextCursor: null } };
/** Each section has its own query; `link` defaults to an empty section. */
const render = (mine: Query, link: Query = empty) => {
  listQuery.mockImplementation(({ section }) => ({
    isPending: false,
    isError: false,
    refetch,
    ...(section === "mine" ? mine : link),
  }));
  act(() => root.render(<CollaborationRoomList />));
};
const section = (name: "mine" | "link") =>
  container.querySelector(`[data-room-section="${name}"]`)!;

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  document.body.appendChild(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const room = (overrides: Record<string, unknown>) => ({
  roomId: "87f19732-2ffa-4fbe-8456-7c221487594f",
  label: "",
  sceneId: null,
  status: "ready",
  role: "owner",
  access: "owned",
  listedAt: 1,
  ...overrides,
});
const buttonIn = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
/** Base UI menus open on click and render their items in a portal. */
const openMenu = async (row: Element) => {
  await act(async () => {
    row
      .querySelector<HTMLButtonElement>('[aria-label="More options"]')
      ?.click();
  });
  return (text: string) =>
    Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes(text),
    ) as HTMLElement | undefined;
};

const MINE_EMPTY = "Rooms you create or are invited to appear here.";
const LINK_EMPTY = "Rooms you open from a shared link appear here.";

describe("collaboration room list (plan 21 §5)", () => {
  it("queries and renders the two sections separately", () => {
    render(
      {
        isSuccess: true,
        data: {
          rooms: [room({ roomId: "aa000000-0000-4000-8000-000000000001" })],
          nextCursor: null,
        },
      },
      {
        isSuccess: true,
        data: {
          rooms: [
            room({
              roomId: "bb000000-0000-4000-8000-000000000002",
              role: "viewer",
              access: "link",
            }),
          ],
          nextCursor: null,
        },
      },
    );
    expect(listQuery.mock.calls.map(([input]) => input.section)).toEqual(
      expect.arrayContaining(["mine", "link"]),
    );
    expect(section("mine").querySelector("h3")?.textContent).toBe(
      "Owned and invited",
    );
    expect(section("link").querySelector("h3")?.textContent).toBe(
      "Opened via link",
    );
    expect(section("mine").textContent).toContain("aa000000");
    expect(section("mine").textContent).not.toContain("bb000000");
    expect(section("link").textContent).toContain("bb000000");
    expect(section("link").textContent).toContain("View only");
  });

  it("shows one empty state for the tab when both sections are empty", () => {
    render(empty);
    const tab = document.querySelector('[aria-label="Rooms"]');
    expect(tab?.textContent).toContain("No rooms yet");
    expect(tab?.querySelectorAll("h3")).toHaveLength(0);
    expect(buttonIn(tab as HTMLElement, "New room")).toBeDefined();
  });

  it("hints inside an empty section when the other has rooms", () => {
    render({ isSuccess: true, data: { rooms: [room({})], nextCursor: null } });
    expect(section("mine").textContent).not.toContain(MINE_EMPTY);
    expect(section("link").textContent).toContain(LINK_EMPTY);
  });

  it("reports a failed query with retry instead of an empty list", () => {
    render({ isError: true });
    expect(section("mine").textContent).toContain("Couldn't load rooms");
    expect(section("mine").textContent).not.toContain(MINE_EMPTY);
    act(() => buttonIn(section("mine"), "Retry")?.click());
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("never shows cached empty data as empty after a failed refetch", () => {
    render({ isError: true, data: { rooms: [], nextCursor: null } });
    expect(section("mine").textContent).toContain("Couldn't load rooms");
    expect(section("mine").textContent).not.toContain(MINE_EMPTY);
  });

  it("distinguishes loading from an empty result", () => {
    render({ isPending: true }, { isPending: true });
    expect(container.textContent).toContain("Loading rooms");
    expect(container.textContent).not.toContain(MINE_EMPTY);
    expect(container.textContent).not.toContain(LINK_EMPTY);
  });

  it("lists invitations not opened yet as invited rooms in the first section", () => {
    render({
      isSuccess: true,
      data: {
        rooms: [room({ role: "editor", access: "invited" })],
        nextCursor: null,
      },
    });
    const row = section("mine").querySelector("li")!;
    expect(row.textContent).toContain("Invited · Can edit");
    expect(buttonIn(row, "Open room")).toBeDefined();
  });

  it("puts unfinished creations first and opens rooms with a plain link", async () => {
    render({
      isSuccess: true,
      data: {
        rooms: [
          room({ roomId: "aa000000-0000-4000-8000-000000000001" }),
          room({
            roomId: "bb000000-0000-4000-8000-000000000002",
            label: "Team board",
            sceneId: "scene-1",
            status: "initializing",
            role: "viewer",
            access: "invited",
          }),
        ],
        nextCursor: null,
      },
    });
    const [unfinished, ready] = Array.from(
      section("mine").querySelectorAll("li"),
    );
    expect(unfinished?.textContent).toContain("Team board");
    expect(unfinished?.textContent).toContain("From a scene");
    expect(unfinished?.textContent).toContain("Setup didn't finish");
    // Only the owner can cancel a creation.
    expect(buttonIn(unfinished!, "Cancel room creation")).toBeUndefined();

    expect(ready?.textContent).toContain("aa000000");
    expect(ready?.textContent).toContain("Owner");
    act(() => buttonIn(ready!, "Open room")?.click());
    expect(push).toHaveBeenCalledOnce();
    const target = new URL(String(push.mock.calls[0]?.[0]));
    expect(target.searchParams.get("collab-room")).toBe(
      "aa000000-0000-4000-8000-000000000001",
    );
    expect(target.hash).toBe("");
    expect(target.href).not.toContain("collab-key");
  });

  it("removes a link-opened room from the list with leave, without confirming", async () => {
    render(empty, {
      isSuccess: true,
      data: {
        rooms: [room({ role: "editor", access: "link" })],
        nextCursor: null,
      },
    });
    const item = await openMenu(section("link").querySelector("li")!);
    expect(item("Leave room")).toBeUndefined();
    expect(item("End room")).toBeUndefined();
    await act(async () => item("Remove from list")?.click());
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      v: 1,
      action: "leave",
      roomId: "87f19732-2ffa-4fbe-8456-7c221487594f",
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Removed from the list. Opening its link again brings it back.",
    );
  });

  it("reports a failed removal like other room actions", async () => {
    execute.mockRejectedValueOnce(new Error("offline"));
    render(empty, {
      isSuccess: true,
      data: { rooms: [room({ access: "link" })], nextCursor: null },
    });
    const item = await openMenu(section("link").querySelector("li")!);
    await act(async () => item("Remove from list")?.click());
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("paginates each section on its own", async () => {
    const nextCursor = {
      listedAt: 1,
      roomId: "87f19732-2ffa-4fbe-8456-7c221487594f",
    };
    render(empty, {
      isSuccess: true,
      data: { rooms: [room({ access: "link" })], nextCursor },
    });
    expect(buttonIn(section("mine"), "Next page")).toBeUndefined();
    listQuery.mockClear();
    act(() => buttonIn(section("link"), "Next page")?.click());
    const inputs = listQuery.mock.calls.map(([input]) => input);
    expect(inputs).toContainEqual(
      expect.objectContaining({ section: "link", cursor: nextCursor }),
    );
    expect(inputs).toContainEqual(
      expect.objectContaining({ section: "mine", cursor: undefined }),
    );
  });

  it("cancels an owner's unfinished creation with cancel-initialization, never end-room", async () => {
    render({
      isSuccess: true,
      data: { rooms: [room({ status: "initializing" })], nextCursor: null },
    });
    await act(async () => {
      buttonIn(container, "Cancel room creation")?.click();
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      action: "cancel-initialization",
      roomId: "87f19732-2ffa-4fbe-8456-7c221487594f",
    });
    expect(toast.success).toHaveBeenCalledWith("Room creation cancelled.");
  });

  it("ends an owned room only after confirming", async () => {
    render({ isSuccess: true, data: { rooms: [room({})], nextCursor: null } });
    const item = await openMenu(container.querySelector("li")!);
    expect(item("Leave room")).toBeUndefined();
    expect(item("Reset link")).toBeUndefined();
    await act(async () => item("End room")?.click());
    expect(execute).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("End this room?");
    await act(async () => {
      buttonIn(document.body, "End room")?.click();
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ action: "end-room" });
    expect(toast.success).toHaveBeenCalledWith(
      "You ended this room. Its content was deleted.",
    );
  });

  it("lets an invited member leave after confirming, without end", async () => {
    render({
      isSuccess: true,
      data: {
        rooms: [room({ role: "editor", access: "invited" })],
        nextCursor: null,
      },
    });
    const item = await openMenu(container.querySelector("li")!);
    expect(item("End room")).toBeUndefined();
    expect(item("Remove from list")).toBeUndefined();
    await act(async () => item("Leave room")?.click());
    expect(document.body.textContent).toContain("Leave this room?");
    await act(async () => {
      buttonIn(
        document.querySelector('[role="alertdialog"]')!,
        "Leave room",
      )?.click();
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ action: "leave" });
  });

  it("locks every other room's management while one intent is unsettled", async () => {
    execute.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      {
        isSuccess: true,
        data: {
          rooms: [
            room({ roomId: "aa000000-0000-4000-8000-000000000001" }),
            room({
              roomId: "cc000000-0000-4000-8000-000000000003",
              status: "initializing",
            }),
          ],
          nextCursor: null,
        },
      },
      {
        isSuccess: true,
        data: {
          rooms: [
            room({
              roomId: "bb000000-0000-4000-8000-000000000002",
              access: "link",
              role: "viewer",
            }),
          ],
          nextCursor: null,
        },
      },
    );
    const ready = (id: string) =>
      Array.from(container.querySelectorAll("li")).find((row) =>
        row.textContent?.includes(id),
      )!;
    let item = await openMenu(ready("aa000000"));
    await act(async () => item("End room")?.click());
    await act(async () => {
      buttonIn(
        document.querySelector('[role="alertdialog"]')!,
        "End room",
      )?.click();
    });
    expect(execute).toHaveBeenCalledOnce();
    // Nothing else can be confirmed only to be dropped.
    expect(buttonIn(container, "Cancel room creation")?.disabled).toBe(true);
    item = await openMenu(ready("bb000000"));
    expect(item("Remove from list")?.hasAttribute("data-disabled")).toBe(true);
  });

  it("offers a fresh creation once its unfinished room is cancelled from the list", async () => {
    const { AuthorityRoomError } =
      await import("@/lib/collab/authority-client");
    creation.start.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    render({
      isSuccess: true,
      data: {
        rooms: [room({ roomId: creation.roomId, status: "initializing" })],
        nextCursor: null,
      },
    });
    await act(async () => {
      buttonIn(container, "New room")?.click();
    });
    expect(buttonIn(container, "Retry initialization")).toBeDefined();
    const row = container.querySelector("li")!;
    await act(async () => {
      buttonIn(row, "Cancel room creation")?.click();
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      action: "cancel-initialization",
    });
    expect(creation.dispose).toHaveBeenCalled();
    expect(buttonIn(container, "Retry initialization")).toBeUndefined();
    expect(buttonIn(container, "New room")).toBeDefined();
  });

  it("opens a newly created room with a plain link", async () => {
    creation.start.mockResolvedValueOnce({
      roomId: creation.roomId,
      projectionPending: false,
    });
    render(empty);
    await act(async () => {
      buttonIn(container, "New room")?.click();
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    const target = new URL(String(push.mock.calls[0]?.[0]));
    expect(target.searchParams.get("collab-room")).toBe(creation.roomId);
    expect(target.hash).toBe("");
  });

  it("offers retry and cancel only once a creation has stopped, not while it runs", async () => {
    creation.start.mockImplementationOnce(() => new Promise(() => undefined));
    render(empty);
    await act(async () => {
      buttonIn(container, "New room")?.click();
    });
    const header = container.querySelector("section > div")!;
    expect(buttonIn(header, "Creating room")?.disabled).toBe(true);
    expect(buttonIn(header, "Retry initialization")).toBeUndefined();
    expect(buttonIn(header, "Cancel room creation")).toBeUndefined();
  });

  it("locks the header's retry and cancel while a row cancellation settles", async () => {
    const { AuthorityRoomError } =
      await import("@/lib/collab/authority-client");
    creation.start.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    execute.mockImplementationOnce(() => new Promise(() => undefined));
    render({
      isSuccess: true,
      data: {
        rooms: [room({ roomId: creation.roomId, status: "initializing" })],
        nextCursor: null,
      },
    });
    await act(async () => {
      buttonIn(container, "New room")?.click();
    });
    const header = container.querySelector("section > div")!;
    await act(async () => {
      buttonIn(container.querySelector("li")!, "Cancel room creation")?.click();
    });
    expect(buttonIn(header, "Retry initialization")?.disabled).toBe(true);
    expect(buttonIn(header, "Cancel room creation")?.disabled).toBe(true);
    await act(async () => {
      buttonIn(header, "Retry initialization")?.click();
      buttonIn(header, "Cancel room creation")?.click();
    });
    expect(creation.start).toHaveBeenCalledOnce();
    expect(creation.cancel).not.toHaveBeenCalled();
  });
});
