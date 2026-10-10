// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createRoomInitialization as RoomInitializer } from "@/lib/collab/room-initialization";

const {
  executeMutate,
  createMutate,
  findForScene,
  initialCapture,
  cancelCreate,
  listInvalidate,
  roomGetInvalidate,
  roomGetUseQuery,
  toastError,
  toastInfo,
  toastSuccess,
} = vi.hoisted(() => ({
  // Room confirms every management intent at once.
  executeMutate: vi.fn((input: { operationId: string }) =>
    Promise.resolve({
      operationId: input.operationId,
      status: "enforced",
      authRevision: 1,
      authorityEpoch: 1,
      projectionPending: false,
    }),
  ),
  findForScene: vi.fn<() => Promise<{ roomId: string } | null>>(),
  initialCapture: {
    current: undefined as Parameters<typeof RoomInitializer>[0] | undefined,
  },
  cancelCreate: vi.fn<() => Promise<void>>(),
  createMutate:
    vi.fn<() => Promise<{ roomId: string; projectionPending?: boolean }>>(),
  listInvalidate: vi.fn(() => Promise.resolve()),
  roomGetInvalidate: vi.fn(() => Promise.resolve()),
  roomGetUseQuery: vi.fn<(...args: unknown[]) => unknown>(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/collab/room-initialization", () => ({
  INITIALIZATION_SETTLE_MS: 15_000,
  createRoomInitialization: (
    options: Parameters<typeof RoomInitializer>[0],
  ) => {
    initialCapture.current = options;
    return { start: createMutate, cancel: cancelCreate };
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    info: toastInfo,
    success: toastSuccess,
    warning: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  // The close control stands in for the X and Escape, which both report
  // onOpenChange(false).
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <>
      {children}
      <button type="button" onClick={() => onOpenChange?.(false)}>
        Close dialog
      </button>
    </>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

// A native <select> stands in for Base UI's popup so a test can pick a value.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  type Item = { value: string; label: string };
  type Context = {
    value: string;
    items: Item[];
    disabled?: boolean;
    onValueChange: (value: string) => void;
  };
  const SelectContext = createContext<Context | null>(null);
  return {
    Select: ({ children, ...context }: Context & { children: ReactNode }) => (
      <SelectContext.Provider value={context}>
        {children}
      </SelectContext.Provider>
    ),
    SelectTrigger: (props: { children: ReactNode; "aria-label"?: string }) => {
      const context = useContext(SelectContext)!;
      return (
        <div>
          <select
            aria-label={props["aria-label"]}
            value={context.value}
            disabled={context.disabled}
            onChange={(event) => context.onValueChange(event.target.value)}
          >
            {context.items.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          {props.children}
        </div>
      );
    },
    SelectValue: () => {
      const context = useContext(SelectContext)!;
      return (
        <span data-slot="select-value">
          {context.items.find((item) => item.value === context.value)?.label}
        </span>
      );
    },
    SelectContent: () => null,
    SelectGroup: () => null,
    SelectItem: () => null,
  };
});

vi.mock("@/components/google-sign-in-button", () => ({
  GoogleSignInButton: ({ label }: { label?: string }) => (
    <button type="button">{label}</button>
  ),
}));

vi.mock("@/hooks/use-app-i18n", async () => {
  // 這兩個 module 沒有被 mock，直接 import 就是真實字典與 translate factory
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return {
    useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }),
  };
});

vi.mock("@/trpc/react", () => ({
  api: {
    useUtils: () => ({
      collaborationRoom: {
        get: { invalidate: roomGetInvalidate },
        list: { invalidate: listInvalidate },
      },
      client: {
        collaborationAuthority: {
          findForScene: { query: findForScene },
          execute: { mutate: executeMutate },
          identity: { mutate: vi.fn() },
        },
      },
    }),
    collaborationRoom: {
      get: {
        useQuery: (...args: unknown[]) => ({
          data: roomGetUseQuery(...args) ?? null,
        }),
      },
    },
  },
}));

import {
  CollaborationRoomDialog,
  type CollaborationRoomDialogProps,
} from "@/components/excalidraw/collaboration-room-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const renderDialog = (
  params: Partial<CollaborationRoomDialogProps> & { isAuthenticated: boolean },
): void => {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  act(() => {
    root?.render(
      <CollaborationRoomDialog
        open
        onOpenChange={params.onOpenChange ?? (() => undefined)}
        isAuthenticated={params.isAuthenticated}
        isAuthenticationPending={params.isAuthenticationPending ?? false}
        sceneId={params.sceneId === undefined ? "scene-1" : params.sceneId}
        getInitialElements={params.getInitialElements ?? (() => [])}
        getInitialFiles={params.getInitialFiles ?? (() => [])}
        onInitializationChange={params.onInitializationChange}
        roomId={params.roomId ?? null}
        onRoomIdChange={params.onRoomIdChange ?? (() => undefined)}
        status={params.status ?? "idle"}
        failureReason={params.failureReason ?? null}
        errorMessage={params.errorMessage ?? null}
        confirmRoomExit={params.confirmRoomExit}
      />,
    );
  });
};

const buttonWith = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
const button = (text: string) => {
  const result = buttonWith(container!, text);
  if (!result) throw new Error(`missing-button:${text}`);
  return result;
};

beforeEach(() => {
  executeMutate.mockClear();
  findForScene.mockReset().mockResolvedValue(null);
  initialCapture.current = undefined;
  cancelCreate.mockReset().mockResolvedValue(undefined);
  createMutate.mockReset().mockResolvedValue({ roomId: "ready-room" });
  listInvalidate.mockClear();
  roomGetInvalidate.mockClear();
  roomGetUseQuery.mockReset();
  toastError.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("collaboration room creation", () => {
  it("captures and pauses the source canvas before scene lookup can yield to a different canvas", async () => {
    let finish: ((candidate: null) => void) | undefined;
    findForScene.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const elements = [
      { id: "source", version: 1, versionNonce: 1, isDeleted: false },
    ];
    const files = [
      {
        id: "a".repeat(40),
        dataURL: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        created: 1,
      },
    ] as unknown as ReturnType<CollaborationRoomDialogProps["getInitialFiles"]>;
    const change = vi.fn();
    renderDialog({
      isAuthenticated: true,
      getInitialElements: () => elements,
      getInitialFiles: () => files,
      onInitializationChange: change,
    });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(findForScene).toHaveBeenCalled());
    });
    expect(change).toHaveBeenCalledWith(true);
    elements[0]!.id = "unrelated-canvas";
    (files[0] as unknown as { dataURL: string }).dataURL =
      "data:image/png;base64,BBBB";
    await act(async () => {
      finish?.(null);
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    });
    expect(initialCapture.current?.elements[0]?.id).toBe("source");
    expect(initialCapture.current?.files?.[0]?.dataURL).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("explains the room's protection without key or encryption wording", () => {
    renderDialog({ isAuthenticated: true });
    const text = container!.textContent ?? "";
    expect(text).toContain("protected by sign-in");
    expect(text).not.toMatch(/\bkey\b|encrypt|complete link/i);
  });

  it("ignores a late initialization success after sign-out and releases the paused personal canvas", async () => {
    let finish: ((ready: { roomId: string }) => void) | undefined;
    createMutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const roomChange = vi.fn();
    const change = vi.fn();
    renderDialog({
      isAuthenticated: true,
      onRoomIdChange: roomChange,
      onInitializationChange: change,
    });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    });
    renderDialog({
      isAuthenticated: false,
      onRoomIdChange: roomChange,
      onInitializationChange: change,
    });
    await act(async () => finish?.({ roomId: "late-room" }));
    expect(roomChange).not.toHaveBeenCalled();
    expect(change).toHaveBeenLastCalledWith(false);
  });

  it("keeps the captured canvas paused for pending initialization; confirmed cancellation releases it", async () => {
    const { AuthorityRoomError } =
      await import("@/lib/collab/authority-client");
    createMutate.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    cancelCreate.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    const change = vi.fn();
    const roomChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      onInitializationChange: change,
      onRoomIdChange: roomChange,
    });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    });
    expect(change).toHaveBeenCalledWith(true);
    expect(change).not.toHaveBeenCalledWith(false);
    expect(roomChange).not.toHaveBeenCalled();
    await act(async () => {
      button("Cancel room creation").click();
      await vi.waitFor(() => expect(cancelCreate).toHaveBeenCalledTimes(1));
    });
    expect(change).not.toHaveBeenCalledWith(false);
    expect(button("Start collaboration").disabled).toBe(true);
    await act(async () => {
      button("Cancel room creation").click();
      await vi.waitFor(() => expect(cancelCreate).toHaveBeenCalledTimes(2));
    });
    expect(change).toHaveBeenLastCalledWith(false);
    expect(roomChange).not.toHaveBeenCalled();
  });

  it("shows sign-in UI and disables the room query for signed-out users", () => {
    renderDialog({ isAuthenticated: false, roomId: "room-from-link" });

    expect(container?.textContent).toContain("Live collaboration");
    expect(container?.textContent).toContain(
      "Sign in to create or join a collaboration room.",
    );
    expect(container?.textContent).toContain("Continue with Google");
    expect(container?.textContent).not.toContain("Start collaboration");
    expect(createMutate).not.toHaveBeenCalled();
    expect(roomGetUseQuery).toHaveBeenCalledWith(
      { roomId: "room-from-link" },
      { enabled: false },
    );
  });

  it("opens a room only after initialization confirms readiness", async () => {
    const roomChange = vi.fn();
    renderDialog({ isAuthenticated: true, onRoomIdChange: roomChange });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(roomChange).toHaveBeenCalled());
    });
    expect(createMutate).toHaveBeenCalledExactlyOnceWith();
    expect(roomChange).toHaveBeenCalledWith("ready-room");
  });

  it("turns a late unauthorized response into a useful message", async () => {
    const error = new TRPCClientError("UNAUTHORIZED");
    Object.defineProperty(error, "data", {
      value: { code: "UNAUTHORIZED" },
    });

    createMutate.mockRejectedValueOnce(error);
    renderDialog({ isAuthenticated: true });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    });

    expect(toastError).toHaveBeenCalledWith(
      "Sign in to create or join a collaboration room.",
    );
  });

  it("starts a standalone room from an unsaved canvas without a scene lookup", async () => {
    const { isCanvasInitializedForRoom } =
      await import("@/lib/collab/initialized-room-handoff");
    const elements = [
      { id: "draft", version: 2, versionNonce: 5, isDeleted: false },
    ] as unknown as ReturnType<
      CollaborationRoomDialogProps["getInitialElements"]
    > &
      object;
    const roomChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      sceneId: null,
      getInitialElements: () => elements,
      onRoomIdChange: roomChange,
    });
    expect(container?.textContent).toContain(
      "Saved in the room, not in My scenes.",
    );
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(roomChange).toHaveBeenCalled());
    });
    expect(findForScene).not.toHaveBeenCalled();
    expect(initialCapture.current?.sceneId).toBeNull();
    expect(roomChange).toHaveBeenCalledWith("ready-room");
    // The join that follows must not ask to save this canvas personally.
    expect(isCanvasInitializedForRoom("ready-room", elements)).toBe(true);
    expect(isCanvasInitializedForRoom("ready-room", [])).toBe(false);
  });

  it("says the room list is still syncing when the projection lags", async () => {
    createMutate.mockResolvedValueOnce({
      roomId: "ready-room",
      projectionPending: true,
    });
    const roomChange = vi.fn();
    renderDialog({ isAuthenticated: true, onRoomIdChange: roomChange });
    await act(async () => {
      button("Start collaboration").click();
      await vi.waitFor(() => expect(roomChange).toHaveBeenCalled());
    });
    expect(toastInfo).toHaveBeenCalledWith(
      "The room may take a moment to appear in your list.",
    );
  });
});

describe("share room dialog", () => {
  const managed = (overrides: Record<string, unknown> = {}) => ({
    roomId: "room-a",
    state: "ready",
    role: "owner",
    linkRole: "none",
    sceneId: null,
    label: "",
    nextCursor: null,
    nextEmailCursor: null,
    members: [
      {
        userId: "u-owner",
        email: "owner@example.com",
        role: "owner",
        lastJoinedAt: 1,
      },
      {
        userId: "u-amy",
        email: "amy@example.com",
        role: "editor",
        lastJoinedAt: 1_700_000_000_000,
      },
      {
        userId: "u-lin",
        email: "lin@example.com",
        role: "viewer",
        lastJoinedAt: 1_700_000_000_000,
      },
      // Opened the room once, has no access now: not listed.
      {
        userId: "u-old",
        email: "old@example.com",
        role: null,
        lastJoinedAt: 1,
      },
    ],
    allowlist: [
      {
        email: "Amy@example.com",
        role: "editor",
        lastJoinedAt: 1_700_000_000_000,
      },
      { email: "bob@example.com", role: "viewer", lastJoinedAt: null },
    ],
    ...overrides,
  });
  const people = () =>
    Array.from(
      container!.querySelectorAll(
        '[aria-labelledby="collab-people-heading"] li',
      ),
    );
  const choose = async (label: string, value: string) => {
    const select = container!.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    );
    if (!select) throw new Error(`missing-select:${label}`);
    await act(async () => {
      Reflect.set(HTMLSelectElement.prototype, "value", value, select);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const menuItem = async (trigger: string, text: string) => {
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>(`[aria-label="${trigger}"]`)
        ?.click();
    });
    const item = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((element) => element.textContent === text) as
      HTMLElement | undefined;
    if (!item) throw new Error(`missing-menuitem:${text}`);
    await act(async () => item.click());
  };
  const confirm = async (label: string) => {
    await act(async () => {
      buttonWith(
        document.querySelector('[role="alertdialog"]')!,
        label,
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const typeInvite = async (value: string) => {
    const input = container!.querySelector<HTMLInputElement>(
      "#collab-allow-email",
    )!;
    await act(async () => {
      Reflect.set(HTMLInputElement.prototype, "value", value, input);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };
  const submitInvite = async (value: string) => {
    const input = await typeInvite(value);
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    return input;
  };

  it("shares a plain link with no fragment", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const link =
      container!.querySelector<HTMLInputElement>("#collab-room-link")!.value;
    expect(new URL(link).searchParams.get("collab-room")).toBe("room-a");
    expect(link).not.toContain("#");
    expect(container!.textContent).not.toMatch(/\bkey\b|complete link/i);
  });

  it("changes general access with set-link-role", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await choose("Who can join with the link", "editor");
    await vi.waitFor(() => expect(executeMutate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "set-link-role",
      roomId: "room-a",
      linkRole: "editor",
    });
  });

  it("lists the owner, the invitation list, then people who joined with the link", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const rows = people().map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("owner@example.com");
    expect(rows[0]).toContain("Owner");
    expect(rows[1]).toContain("Amy@example.com");
    expect(rows[1]).toContain("Joined");
    expect(rows[2]).toContain("bob@example.com");
    expect(rows[2]).toContain("Not joined yet");
    expect(rows[3]).toContain("lin@example.com");
    expect(rows[3]).toContain("Joined with the link");
    expect(rows.join()).not.toContain("old@example.com");
    // Only invitations are managed here.
    expect(
      container!.querySelector('[aria-label="Actions for lin@example.com"]'),
    ).toBeNull();
    expect(
      container!.querySelector('select[aria-label="Role for lin@example.com"]'),
    ).toBeNull();
  });

  it("changes an invitation's role with allow-email", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await choose("Role for bob@example.com", "editor");
    await vi.waitFor(() => expect(executeMutate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "allow-email",
      email: "bob@example.com",
      role: "editor",
    });
  });

  it("removes an invitation with remove-email", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await menuItem("Actions for bob@example.com", "Remove invitation");
    await vi.waitFor(() => expect(executeMutate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "remove-email",
      email: "bob@example.com",
    });
  });

  it("invites by email and clears the field once Room confirms", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await choose("Role for the invitation", "editor");
    const input = await submitInvite("Carol@Example.com ");
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "allow-email",
      email: "Carol@Example.com",
      role: "editor",
    });
  });

  it("keeps Backspace in the invite field and refuses a malformed address", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const input = await submitInvite("carol@");
    // Excalidraw lets keys through only to text, number and password inputs.
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("email");
    expect(executeMutate).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("clears the invite field when a retried invitation is confirmed, not before", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    // The reply is lost: the outcome is unknown, so the intent is retained.
    executeMutate.mockImplementationOnce(() =>
      Promise.reject(new Error("network")),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const input = await submitInvite("gil@example.com");
    await vi.waitFor(() =>
      expect(buttonWith(container!, "Retry")).toBeDefined(),
    );
    // An unknown outcome is not confirmation, and it is explained.
    expect(input.value).toBe("gil@example.com");
    expect(container!.textContent).toContain(
      "Your last change wasn't confirmed.",
    );
    await act(async () => button("Retry").click());
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(executeMutate.mock.calls[1]?.[0]).toMatchObject({ action: "query" });
  });

  it("keeps the pending invitation's address when another invite is refused", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    // The reply is lost: the outcome is unknown, so the intent is retained.
    executeMutate.mockImplementationOnce(() =>
      Promise.reject(new Error("network")),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await submitInvite("ann@example.com");
    await vi.waitFor(() =>
      expect(buttonWith(container!, "Retry")).toBeDefined(),
    );
    // Refused while Ann's invitation is retained.
    await submitInvite("ben@example.com");
    const input = await typeInvite("ann@example.com");
    await act(async () => button("Retry").click());
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  const pendingReceipt = (input: { operationId: string }) =>
    Promise.resolve({
      operationId: input.operationId,
      status: "pending",
      authRevision: 1,
      authorityEpoch: 1,
      projectionPending: false,
    });

  it("treats a pending removal as done once Room enforces it, with no retry", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    // Room stores the removal and cuts the person off from its alarm.
    executeMutate.mockImplementationOnce(pendingReceipt);
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await menuItem("Actions for bob@example.com", "Remove invitation");
    await vi.waitFor(() => expect(roomGetInvalidate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[1]?.[0]).toMatchObject({ action: "query" });
    expect(buttonWith(container!, "Retry")).toBeUndefined();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("accepts a removal Room is still enforcing and refreshes the panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      roomGetUseQuery.mockReturnValue(managed());
      executeMutate.mockImplementation(pendingReceipt);
      renderDialog({ isAuthenticated: true, roomId: "room-a" });
      await menuItem("Actions for bob@example.com", "Remove invitation");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await vi.waitFor(() => expect(roomGetInvalidate).toHaveBeenCalled());
      expect(buttonWith(container!, "Retry")).toBeUndefined();
      expect(toastInfo).toHaveBeenCalledWith(
        "Permissions updated. They may take a moment to apply.",
      );
    } finally {
      executeMutate.mockImplementation((input: { operationId: string }) =>
        Promise.resolve({
          operationId: input.operationId,
          status: "enforced",
          authRevision: 1,
          authorityEpoch: 1,
          projectionPending: false,
        }),
      );
      vi.useRealTimers();
    }
  });

  it("keeps an accepted removal accepted when the follow-up check fails", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    executeMutate
      .mockImplementationOnce(pendingReceipt)
      .mockImplementationOnce(() => Promise.reject(new Error("network")));
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await menuItem("Actions for bob@example.com", "Remove invitation");
    await vi.waitFor(() => expect(roomGetInvalidate).toHaveBeenCalled());
    expect(buttonWith(container!, "Retry")).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows a terminal room after an earlier exit from another room", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    const onRoomIdChange = vi.fn();
    // The cleared room id commits while the exit is still refreshing, as the
    // URL state does in the editor.
    let releaseRefresh: (() => void) | undefined;
    roomGetInvalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a", onRoomIdChange });
    await act(async () => button("End room").click());
    await confirm("End room");
    await vi.waitFor(() => expect(onRoomIdChange).toHaveBeenCalledWith(null));
    renderDialog({ isAuthenticated: true, roomId: null });
    await act(async () => releaseRefresh?.());
    roomGetUseQuery.mockReturnValue(null);
    renderDialog({
      isAuthenticated: true,
      roomId: "room-b",
      status: "failed",
      failureReason: "room-ended",
    });
    expect(container!.textContent).toContain(
      "This room has ended or doesn't exist",
    );
  });

  it("shows the general access being applied until Room answers", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    let release: (() => void) | undefined;
    executeMutate.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              operationId: input.operationId,
              status: "enforced",
              authRevision: 1,
              authorityEpoch: 1,
              projectionPending: false,
            });
        }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await choose("Who can join with the link", "viewer");
    const select = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Who can join with the link"]',
    )!;
    expect(select.value).toBe("viewer");
    await act(async () => release?.());
    await vi.waitFor(() => expect(roomGetInvalidate).toHaveBeenCalled());
  });

  it("says the room was ended and deleted after the owner ends it", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await act(async () => button("End room").click());
    await confirm("End room");
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "You ended this room. Its content was deleted.",
      ),
    );
  });

  it("shows role and link-access labels, not their raw values", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const values = Array.from(
      container!.querySelectorAll('[data-slot="select-value"]'),
    ).map((value) => value.textContent);
    expect(values).toEqual(
      expect.arrayContaining(["Invited people only", "View only", "Can edit"]),
    );
    expect(values).not.toContain("none");
    expect(values).not.toContain("viewer");
  });

  it("gives the owner only End room under Manage room, and no reset, paste or key UI", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    expect(buttonWith(container!, "End room")).toBeDefined();
    expect(buttonWith(container!, "Leave room")).toBeUndefined();
    expect(buttonWith(container!, "Reset link")).toBeUndefined();
    expect(buttonWith(container!, "Reset canvas")).toBeUndefined();
    expect(container!.querySelector("#collab-room-full-link")).toBeNull();
    expect(container!.textContent).not.toContain("Restore");
  });

  it("gives other members only the link and leaving", () => {
    roomGetUseQuery.mockReturnValue(
      managed({ role: "editor", members: [], allowlist: [] }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    expect(container!.querySelector("#collab-room-link")).not.toBeNull();
    expect(container!.querySelector("#collab-allow-email")).toBeNull();
    expect(container!.querySelector("#collab-link-role")).toBeNull();
    expect(buttonWith(container!, "End room")).toBeUndefined();
    expect(buttonWith(container!, "Leave room")).toBeDefined();
  });

  it.each([
    ["owner", "End room", "end-room"],
    ["viewer", "Leave room", "leave"],
  ] as const)(
    "as %s, confirms %s and leaves without refetching the inaccessible room",
    async (role, label, action) => {
      roomGetUseQuery.mockReturnValue(managed({ role }));
      const onOpenChange = vi.fn();
      const onRoomIdChange = vi.fn();
      renderDialog({
        isAuthenticated: true,
        roomId: "room-a",
        onOpenChange,
        onRoomIdChange,
      });
      await act(async () => button(label).click());
      // Nothing happens until the consequences are confirmed.
      expect(executeMutate).not.toHaveBeenCalled();
      await confirm(label);
      await vi.waitFor(() => expect(onRoomIdChange).toHaveBeenCalledWith(null));
      expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
        action,
        roomId: "room-a",
      });
      expect(roomGetInvalidate).toHaveBeenCalledWith(undefined, {
        refetchType: "none",
      });
      expect(listInvalidate).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("says the leave may be undone by the link when general access allows it", async () => {
    roomGetUseQuery.mockReturnValue(managed({ role: "viewer" }));
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await act(async () => button("Leave room").click());
    expect(document.body.textContent).toContain(
      "unless anyone with the link can open it",
    );
  });
});

describe("no-access screen", () => {
  it("says the account has no access and offers only the way back", async () => {
    roomGetUseQuery.mockReturnValue(null);
    const onOpenChange = vi.fn();
    const onRoomIdChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "no-access",
      errorMessage: "You don't have access to this room.",
      onOpenChange,
      onRoomIdChange,
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("You don't have access to this room");
    expect(text).toContain("Ask the owner for an invitation");
    // The room's management data is not requested for a refused account.
    expect(roomGetUseQuery).toHaveBeenLastCalledWith(
      { roomId: "room-a" },
      { enabled: false },
    );
    expect(container!.querySelector("input")).toBeNull();
    expect(container!.querySelector("form")).toBeNull();
    expect(buttonWith(container!, "Leave room")).toBeUndefined();
    await act(async () => button("Back to my canvas").click());
    expect(onRoomIdChange).toHaveBeenCalledWith(null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the room when leaving would discard unsaved edits and the user cancels", async () => {
    roomGetUseQuery.mockReturnValue(null);
    const onOpenChange = vi.fn();
    const onRoomIdChange = vi.fn();
    const confirmRoomExit = vi.fn(() => false);
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "no-access",
      errorMessage: "You don't have access to this room.",
      onOpenChange,
      onRoomIdChange,
      confirmRoomExit,
    });
    await act(async () => button("Back to my canvas").click());
    expect(confirmRoomExit).toHaveBeenCalledOnce();
    expect(onRoomIdChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("says a missing or ended room is gone and offers only the way back", async () => {
    roomGetUseQuery.mockReturnValue(null);
    const onRoomIdChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "room-ended",
      errorMessage: "This room has ended or doesn't exist.",
      onRoomIdChange,
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("This room has ended or doesn't exist");
    expect(text).toContain("Check the link, or ask the person who shared it.");
    expect(text).not.toContain("Ask the sharer");
    expect(container!.querySelector("#collab-room-link")).toBeNull();
    expect(buttonWith(container!, "End room")).toBeUndefined();
    expect(buttonWith(container!, "Retry")).toBeUndefined();
    await act(async () => button("Back to my canvas").click());
    expect(onRoomIdChange).toHaveBeenCalledWith(null);
  });

  it("says access was removed when the session had been in the room", () => {
    roomGetUseQuery.mockReturnValue(null);
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "connected",
    });
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "no-access",
      errorMessage: "You don't have access to this room.",
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("Your access to this room was removed");
    expect(text).toContain("ask the owner to invite you again");
  });

  it("keeps a terminal dialog open until its button is pressed", async () => {
    roomGetUseQuery.mockReturnValue(null);
    const onOpenChange = vi.fn();
    const onRoomIdChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "no-access",
      onOpenChange,
      onRoomIdChange,
    });
    // X, outside click and Escape all report onOpenChange(false); none closes it.
    await act(async () => button("Close dialog").click());
    expect(onRoomIdChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => button("Back to my canvas").click());
    expect(onRoomIdChange).toHaveBeenCalledWith(null);
  });

  it("keeps the share view for other failures", () => {
    roomGetUseQuery.mockReturnValue(null);
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "failed",
      failureReason: "protocol-violation",
      errorMessage: "The connection stopped because of a protocol error.",
    });
    expect(container!.textContent).toContain("protocol error");
    expect(container!.querySelector("#collab-room-link")).not.toBeNull();
  });
});
