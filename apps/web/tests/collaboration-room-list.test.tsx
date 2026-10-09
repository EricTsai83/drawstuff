// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listQuery, push, refetch, execute, invalidate, toast, roomKeyMutate } =
  vi.hoisted(() => ({
    listQuery: vi.fn<() => unknown>(),
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
    roomKeyMutate: vi.fn(() => Promise.resolve(null)),
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  }));

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
          roomKey: { mutate: roomKeyMutate },
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
  listedAt: 1,
  projectionVersion: 1,
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

describe("collaboration room list (18C §2)", () => {
  it("reports a failed query with retry instead of an empty list", () => {
    render({ isError: true });
    expect(container.textContent).toContain("Couldn't load rooms");
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
    expect(container.textContent).toContain("Couldn't load rooms");
    expect(container.textContent).not.toContain("no collaboration rooms yet");
  });

  it("distinguishes loading from an empty result", () => {
    render({ isPending: true });
    expect(container.textContent).toContain("Loading rooms");
    expect(container.textContent).not.toContain("no collaboration rooms yet");
    render({ isSuccess: true, data: { rooms: [], nextCursor: null } });
    expect(container.textContent).toContain(
      "You have no collaboration rooms yet.",
    );
  });

  it("puts unfinished creations under Needs attention, ahead of the rooms", async () => {
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
          }),
        ],
        nextCursor: null,
      },
    });
    const groups = Array.from(container.querySelectorAll("ul"));
    expect(
      groups.map((group) => group.previousElementSibling?.textContent),
    ).toEqual(["Needs attention", "Rooms"]);
    const [unfinished] = Array.from(groups[0]!.querySelectorAll("li"));
    expect(unfinished?.textContent).toContain("Team board");
    expect(unfinished?.textContent).toContain("From a scene · View only");
    expect(unfinished?.textContent).toContain("Setup didn't finish");
    // Only the owner can cancel a creation.
    expect(buttonIn(unfinished!, "Cancel room creation")).toBeUndefined();

    const [ready] = Array.from(groups[1]!.querySelectorAll("li"));
    expect(ready?.textContent).toContain("aa000000");
    expect(ready?.textContent).toContain("Owner");
    await act(async () => {
      buttonIn(ready!, "Open room")?.click();
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    const target = new URL(String(push.mock.calls[0]?.[0]));
    expect(target.searchParams.get("collab-room")).toBe(
      "aa000000-0000-4000-8000-000000000001",
    );
    expect(target.hash).toBe("");
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
    await act(async () => item("End room")?.click());
    expect(execute).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("End this room?");
    await act(async () => {
      buttonIn(document.body, "End room")?.click();
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ action: "end-room" });
    expect(toast.success).toHaveBeenCalledWith("Room ended.");
  });

  it("lets a member leave, without end or link reset options", async () => {
    render({
      isSuccess: true,
      data: { rooms: [room({ role: "editor" })], nextCursor: null },
    });
    const item = await openMenu(container.querySelector("li")!);
    expect(item("End room")).toBeUndefined();
    expect(item("Reset link")).toBeUndefined();
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

  it("sends link resets to the room, which needs its key", async () => {
    render({ isSuccess: true, data: { rooms: [room({})], nextCursor: null } });
    const item = await openMenu(container.querySelector("li")!);
    await act(async () => item("Reset link")?.click());
    expect(execute).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "In the room, open Share room and choose Reset link.",
    );
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    expect(
      new URL(String(push.mock.calls[0]?.[0])).searchParams.get("collab-room"),
    ).toBe("87f19732-2ffa-4fbe-8456-7c221487594f");
  });

  it("locks every other room's management while one intent is unsettled", async () => {
    execute.mockImplementationOnce(() => new Promise(() => undefined));
    render({
      isSuccess: true,
      data: {
        rooms: [
          room({ roomId: "aa000000-0000-4000-8000-000000000001" }),
          room({ roomId: "bb000000-0000-4000-8000-000000000002" }),
          room({
            roomId: "cc000000-0000-4000-8000-000000000003",
            status: "initializing",
          }),
        ],
        nextCursor: null,
      },
    });
    const rows = () => Array.from(container.querySelectorAll("li"));
    const ready = (id: string) =>
      rows().find((row) => row.textContent?.includes(id))!;
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
    expect(item("End room")?.hasAttribute("data-disabled")).toBe(true);
  });

  it("offers a fresh creation once its unfinished room is cancelled from the list", async () => {
    const { AuthorityRoomError } =
      await import("@/lib/collab/authority-client");
    creation.start.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    const list = {
      isSuccess: true,
      data: {
        rooms: [room({ roomId: creation.roomId, status: "initializing" })],
        nextCursor: null,
      },
    };
    render(list);
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

  it("offers retry and cancel only once a creation has stopped, not while it runs", async () => {
    creation.start.mockImplementationOnce(() => new Promise(() => undefined));
    render({ isSuccess: true, data: { rooms: [], nextCursor: null } });
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

  it("opens a room with Room's custody copy of its key", async () => {
    roomKeyMutate.mockResolvedValueOnce({
      roomKey: "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
      authGeneration: 1,
    } as never);
    render({ isSuccess: true, data: { rooms: [room({})], nextCursor: null } });
    await act(async () => {
      buttonIn(container, "Open room")?.click();
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    const target = new URL(String(push.mock.calls[0]?.[0]));
    expect(target.hash).toBe(
      "#collab-key=T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
    );
    // The key stays in the fragment, never in what the server receives.
    expect(target.search).not.toContain("T0PSTFR2");
  });
});
