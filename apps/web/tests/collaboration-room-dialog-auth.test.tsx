// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createRoomInitialization as RoomInitializer } from "@/lib/collab/room-initialization";
import type * as SnapshotHttp from "@/lib/collab/snapshot-http";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { SnapshotApi } from "@/lib/collab/snapshot-http";

const {
  executeMutate,
  createMutate,
  findForScene,
  initialCapture,
  cancelCreate,
  endSuccessHandler,
  getActiveForSceneInvalidate,
  idleMutate,
  leaveSuccessHandler,
  roomGetInvalidate,
  roomGetUseQuery,
  toastError,
  toastInfo,
  toastSuccess,
  binaryApi,
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
  createMutate: vi.fn<
    () => Promise<{
      roomId: string;
      roomKey: RoomKey;
      projectionPending?: boolean;
    }>
  >(),
  endSuccessHandler: {
    current: undefined as
      | ((result: { enforcement: "enforced" | "pending" }) => Promise<void>)
      | undefined,
  },
  getActiveForSceneInvalidate: vi.fn(() => Promise.resolve()),
  idleMutate: vi.fn(),
  leaveSuccessHandler: {
    current: undefined as
      | ((result: { enforcement: "enforced" | "pending" }) => Promise<void>)
      | undefined,
  },
  roomGetInvalidate: vi.fn(() => Promise.resolve()),
  roomGetUseQuery: vi.fn<(...args: unknown[]) => unknown>(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  binaryApi: {
    read: vi.fn<SnapshotApi["read"]>(),
    write: vi.fn<SnapshotApi["write"]>(),
    query: vi.fn<SnapshotApi["query"]>(),
    cancel: vi.fn<SnapshotApi["cancel"]>(),
  },
}));
vi.mock("@/lib/collab/snapshot-http", async (original) => ({
  ...(await original<typeof SnapshotHttp>()),
  createBinarySnapshotClient: () => binaryApi,
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
  Dialog: ({ children }: { children: ReactNode }) => children,
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

vi.mock("@/trpc/react", () => {
  const idleMutation = { isPending: false, mutate: idleMutate };
  return {
    api: {
      useUtils: () => ({
        collaborationRoom: {
          get: { invalidate: roomGetInvalidate },
          list: { invalidate: getActiveForSceneInvalidate },
        },
        client: {
          collaborationRoom: {
            setKeyCheck: { mutate: vi.fn() },
          },
          collaborationAuthority: {
            findForScene: { query: findForScene },
            execute: { mutate: executeMutate },
            identity: { mutate: vi.fn() },
          },
        },
      }),
      collaborationRoom: {
        get: {
          useQuery: (...args: unknown[]) => {
            return { data: roomGetUseQuery(...args) ?? null };
          },
        },
        end: {
          useMutation: (options: {
            onSuccess?: (result: {
              enforcement: "enforced" | "pending";
            }) => Promise<void>;
          }) => {
            endSuccessHandler.current = options.onSuccess;
            return idleMutation;
          },
        },
        leave: {
          useMutation: (options: {
            onSuccess?: (result: {
              enforcement: "enforced" | "pending";
            }) => Promise<void>;
          }) => {
            leaveSuccessHandler.current = options.onSuccess;
            return idleMutation;
          },
        },
        removeMember: { useMutation: () => idleMutation },
        setMemberRole: { useMutation: () => idleMutation },
        setLinkRole: { useMutation: () => idleMutation },
        rotateGeneration: { useMutation: () => idleMutation },
      },
    },
  };
});

import {
  CollaborationRoomDialog,
  type CollaborationRoomDialogProps,
} from "@/components/excalidraw/collaboration-room-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const renderDialog = (params: {
  isAuthenticated: boolean;
  isAuthenticationPending?: boolean;
  roomId?: string | null;
  onOpenChange?: (open: boolean) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onRoomKeyChange?: CollaborationRoomDialogProps["onRoomKeyChange"];
  failureReason?: CollaborationRoomDialogProps["failureReason"];
  status?: CollaborationRoomDialogProps["status"];
  sceneId?: string | null;
  onRetryJoin?: () => void;
  roomKey?: RoomKey | null;
  errorMessage?: string | null;
  onInitializationChange?: (active: boolean) => void;
  getInitialElements?: CollaborationRoomDialogProps["getInitialElements"];
  getInitialFiles?: CollaborationRoomDialogProps["getInitialFiles"];
}): void => {
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
        roomKey={params.roomKey ?? null}
        onRoomKeyChange={params.onRoomKeyChange ?? (() => undefined)}
        status={params.status ?? "idle"}
        failureReason={params.failureReason ?? null}
        role={null}
        errorMessage={params.errorMessage ?? null}
        onRetryJoin={params.onRetryJoin ?? (() => undefined)}
      />,
    );
  });
};

beforeEach(() => {
  executeMutate.mockClear();
  findForScene.mockReset().mockResolvedValue(null);
  initialCapture.current = undefined;
  cancelCreate.mockReset().mockResolvedValue(undefined);
  endSuccessHandler.current = undefined;
  leaveSuccessHandler.current = undefined;
  createMutate.mockReset().mockResolvedValue({
    roomId: "ready-room",
    roomKey: "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey,
  });
  getActiveForSceneInvalidate.mockClear();
  roomGetInvalidate.mockClear();
  roomGetUseQuery.mockReset();
  toastError.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  binaryApi.read.mockReset().mockImplementation(async (request) => ({
    found: false,
    bytes: null,
    receipt: {
      roomId: request.roomId,
      authGeneration: 1,
      authorityEpoch: 1,
      revision: 4,
    },
  }));
  binaryApi.write.mockReset().mockResolvedValue({ status: "pending" });
  binaryApi.query.mockReset().mockResolvedValue({ status: "pending" });
  binaryApi.cancel.mockReset().mockResolvedValue({ status: "cancelled" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("collaboration room authentication guard", () => {
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
      Array.from(container?.querySelectorAll("button") ?? [])
        .find(
          (button) => button.textContent === "Start encrypted collaboration",
        )
        ?.click();
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
  it("ignores a late initialization success after sign-out and releases the paused personal canvas", async () => {
    let finish:
      ((ready: { roomId: string; roomKey: RoomKey }) => void) | undefined;
    createMutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const keyChange = vi.fn();
    const roomChange = vi.fn();
    const change = vi.fn();
    renderDialog({
      isAuthenticated: true,
      onRoomKeyChange: keyChange,
      onRoomIdChange: roomChange,
      onInitializationChange: change,
    });
    await act(async () => {
      Array.from(container?.querySelectorAll("button") ?? [])
        .find(
          (button) => button.textContent === "Start encrypted collaboration",
        )
        ?.click();
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    });
    renderDialog({
      isAuthenticated: false,
      onRoomKeyChange: keyChange,
      onRoomIdChange: roomChange,
      onInitializationChange: change,
    });
    await act(async () => {
      finish?.({
        roomId: "late-room",
        roomKey: "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey,
      });
    });
    expect(keyChange).not.toHaveBeenCalled();
    expect(roomChange).not.toHaveBeenCalled();
    expect(change).toHaveBeenLastCalledWith(false);
  });
  it("keeps the captured canvas paused and never exposes a key for pending initialization; confirmed cancellation releases it", async () => {
    const { AuthorityRoomError } =
      await import("@/lib/collab/authority-client");
    createMutate.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    cancelCreate.mockRejectedValueOnce(new AuthorityRoomError("pending"));
    const change = vi.fn();
    const keyChange = vi.fn();
    const roomChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      onInitializationChange: change,
      onRoomKeyChange: keyChange,
      onRoomIdChange: roomChange,
    });
    const button = (text: string) => {
      const result = Array.from(
        container?.querySelectorAll("button") ?? [],
      ).find((button) => button.textContent === text);
      if (!result) throw new Error(`missing-button:${text}`);
      return result;
    };
    await act(async () => {
      button("Start encrypted collaboration").click();
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    });
    expect(change).toHaveBeenCalledWith(true);
    expect(change).not.toHaveBeenCalledWith(false);
    expect(keyChange).not.toHaveBeenCalled();
    expect(roomChange).not.toHaveBeenCalled();
    await act(async () => {
      button("Cancel room creation").click();
      await vi.waitFor(() => expect(cancelCreate).toHaveBeenCalledTimes(1));
    });
    expect(change).not.toHaveBeenCalledWith(false);
    expect(button("Start encrypted collaboration").disabled).toBe(true);
    await act(async () => {
      button("Cancel room creation").click();
      await vi.waitFor(() => expect(cancelCreate).toHaveBeenCalledTimes(2));
    });
    expect(change).toHaveBeenLastCalledWith(false);
    expect(keyChange).not.toHaveBeenCalled();
    expect(roomChange).not.toHaveBeenCalled();
  });

  it("shows no reset success or join retry for pending, then recovers the same operation on a confirmed button retry", async () => {
    roomGetUseQuery.mockReturnValue({
      allowlist: [],
      role: "owner",
      members: [],
      linkRole: "none",
      authGeneration: 1,
    });
    const retryJoin = vi.fn();
    renderDialog({
      isAuthenticated: true,
      roomId: "reset-room",
      failureReason: "unreadable-room",
      onRetryJoin: retryJoin,
    });
    const button = (text: string) => {
      const result = Array.from(
        container?.querySelectorAll("button") ?? [],
      ).find((el) => el.textContent === text);
      if (!result) throw new Error(`missing-button:${text}`);
      return result;
    };
    act(() => button("Reset canvas").click());
    await act(async () => {
      button("Delete cloud canvas").click();
      await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(retryJoin).not.toHaveBeenCalled();
    const operation = binaryApi.write.mock.calls[0]![0];
    expect(operation).toMatchObject({
      kind: "snapshot-reset",
      expectedRevision: 4,
    });
    expect(binaryApi.write.mock.calls[0]![1].byteLength).toBe(0);
    binaryApi.query.mockResolvedValueOnce({ status: "written", revision: 5 });
    await act(async () => {
      button("Delete cloud canvas").click();
      await vi.waitFor(() => expect(retryJoin).toHaveBeenCalledTimes(1));
    });
    expect(binaryApi.query).toHaveBeenCalledWith(operation);
    expect(binaryApi.write).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });
  it("shows sign-in UI and disables the room query for signed-out users", () => {
    renderDialog({ isAuthenticated: false, roomId: "room-from-link" });

    expect(container?.textContent).toContain("Live collaboration");
    expect(container?.textContent).toContain(
      "Sign in to create or join a collaboration room.",
    );
    expect(container?.textContent).toContain("Continue with Google");
    expect(container?.textContent).not.toContain("不支援匿名加入");
    expect(container?.textContent).not.toContain(
      "Start encrypted collaboration",
    );
    expect(createMutate).not.toHaveBeenCalled();
    expect(roomGetUseQuery).toHaveBeenCalledWith(
      { roomId: "room-from-link", includeRevokedMembers: true },
      { enabled: false },
    );
  });

  it("opens a room only after initialization confirms readiness", async () => {
    renderDialog({ isAuthenticated: true });
    const startButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Start encrypted collaboration");

    expect(startButton).toBeDefined();
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    });
    expect(createMutate).toHaveBeenCalledWith();
  });

  it("turns a late unauthorized response into a useful message", async () => {
    const error = new TRPCClientError("UNAUTHORIZED");
    Object.defineProperty(error, "data", {
      value: { code: "UNAUTHORIZED" },
    });

    createMutate.mockRejectedValueOnce(error);
    renderDialog({ isAuthenticated: true });
    await act(async () => {
      const start = Array.from(
        container?.querySelectorAll("button") ?? [],
      ).find(
        (button) => button.textContent === "Start encrypted collaboration",
      );
      start?.click();
      await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    });

    expect(toastError).toHaveBeenCalledWith(
      "Sign in to create or join a collaboration room.",
    );
  });
});

describe("collaboration room exit cache cleanup", () => {
  it.each([
    ["ending", endSuccessHandler],
    ["leaving", leaveSuccessHandler],
  ] as const)(
    "marks the inaccessible room stale without refetching after %s",
    async (operation, _successHandler) => {
      const onOpenChange = vi.fn();
      const onRoomIdChange = vi.fn();
      const onRoomKeyChange = vi.fn();
      renderDialog({
        isAuthenticated: true,
        roomId: "room-exited",
        onOpenChange,
        onRoomIdChange,
        onRoomKeyChange,
      });

      roomGetUseQuery.mockReturnValue({
        role: operation === "ending" ? "owner" : "viewer",
        members: [],
        allowlist: [],
        linkRole: "none",
      });
      renderDialog({
        isAuthenticated: true,
        roomId: "room-exited",
        onOpenChange,
        onRoomIdChange,
        onRoomKeyChange,
      });
      const label = operation === "ending" ? "End room" : "Leave room";
      await act(async () => {
        const button = Array.from(container!.querySelectorAll("button")).find(
          (button) => button.textContent === label,
        );
        expect(button).toBeDefined();
        button?.click();
      });
      // Nothing happens until the consequences are confirmed.
      expect(onRoomIdChange).not.toHaveBeenCalled();
      await act(async () => {
        Array.from(document.querySelectorAll('[role="alertdialog"] button'))
          .find((button) => button.textContent === label)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(onRoomIdChange).toHaveBeenCalledWith(null);
      expect(onRoomKeyChange).toHaveBeenCalledWith(null);
      expect(roomGetInvalidate).toHaveBeenCalledWith(undefined, {
        refetchType: "none",
      });
      expect(getActiveForSceneInvalidate).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("applies a pasted complete link for the same room and rejects other rooms or partial links", async () => {
    const { buildRoomInviteUrl } = await import("@/lib/collab/room-link");
    const roomKey = "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey;
    const keyChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "missing-room-key",
      onRoomKeyChange: keyChange,
    });
    const input = container?.querySelector<HTMLInputElement>(
      "#collab-room-full-link",
    );
    const form = input?.closest("form");
    if (!input || !form) throw new Error("missing-key form not rendered");
    const submit = (value: string) =>
      act(() => {
        // React tracks the last value it rendered; going through the
        // prototype setter makes the change visible to its onChange.
        Reflect.set(HTMLInputElement.prototype, "value", value, input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
    const link = (roomId: string, key: RoomKey | null) =>
      buildRoomInviteUrl({
        currentUrl: "https://drawstuff.example/",
        roomId,
        roomKey: key,
      });

    submit(link("room-b", roomKey));
    submit(link("room-a", null));
    expect(keyChange).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(
      "This link is for a different room or is missing its key.",
    );

    submit(link("room-a", roomKey));
    expect(keyChange).toHaveBeenCalledExactlyOnceWith(roomKey);
    expect(input.value).toBe("");
  });

  it("does not offer the pasted-link form while the room has its key", () => {
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    expect(container?.querySelector("#collab-room-full-link")).toBeNull();
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
    const keyChange = vi.fn();
    const roomChange = vi.fn();
    renderDialog({
      isAuthenticated: true,
      sceneId: null,
      getInitialElements: () => elements,
      onRoomKeyChange: keyChange,
      onRoomIdChange: roomChange,
    });
    expect(container?.textContent).toContain(
      "Saved encrypted in the room, not as a personal cloud scene.",
    );
    expect(container?.textContent).not.toContain("saved personal scene");
    await act(async () => {
      Array.from(container?.querySelectorAll("button") ?? [])
        .find(
          (button) => button.textContent === "Start encrypted collaboration",
        )
        ?.click();
      await vi.waitFor(() => expect(roomChange).toHaveBeenCalled());
    });
    expect(findForScene).not.toHaveBeenCalled();
    expect(initialCapture.current?.sceneId).toBeNull();
    expect(roomChange).toHaveBeenCalledWith("ready-room");
    expect(keyChange).toHaveBeenCalledWith(
      "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
    );
    // The join that follows must not ask to save this canvas personally.
    expect(isCanvasInitializedForRoom("ready-room", elements)).toBe(true);
    expect(isCanvasInitializedForRoom("ready-room", [])).toBe(false);
  });

  it("says the room list is still syncing when the projection lags", async () => {
    createMutate.mockResolvedValueOnce({
      roomId: "ready-room",
      roomKey: "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey,
      projectionPending: true,
    });
    const roomChange = vi.fn();
    renderDialog({ isAuthenticated: true, onRoomIdChange: roomChange });
    await act(async () => {
      Array.from(container?.querySelectorAll("button") ?? [])
        .find(
          (button) => button.textContent === "Start encrypted collaboration",
        )
        ?.click();
      await vi.waitFor(() => expect(roomChange).toHaveBeenCalled());
    });
    expect(toastInfo).toHaveBeenCalledWith(
      "The room is ready. Your room list is still syncing, so it may appear there a little later.",
    );
  });
});

describe("share room dialog", () => {
  const managed = (overrides: Record<string, unknown> = {}) => ({
    role: "owner",
    linkRole: "none",
    sceneId: null,
    authGeneration: 1,
    nextCursor: null,
    nextEmailCursor: null,
    members: [
      {
        userId: "u-owner",
        name: "owner@example.com",
        role: "owner",
        revoked: false,
        lastJoinedAt: null,
      },
      {
        userId: "u-amy",
        name: "amy@example.com",
        role: "editor",
        revoked: false,
        lastJoinedAt: 1_700_000_000_000,
      },
    ],
    allowlist: [
      {
        email: "amy@example.com",
        role: "editor",
        removed: false,
        lastJoinedAt: 1_700_000_000_000,
      },
      {
        email: "bob@example.com",
        role: "viewer",
        removed: false,
        lastJoinedAt: null,
      },
    ],
    ...overrides,
  });
  const people = () =>
    Array.from(
      container!.querySelectorAll(
        '[aria-labelledby="collab-people-heading"] li',
      ),
    );
  const buttonWith = (scope: ParentNode, text: string) =>
    Array.from(scope.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    );
  const confirm = async (label: string) => {
    await act(async () => {
      buttonWith(
        document.querySelector('[role="alertdialog"]')!,
        label,
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("lists each person once, with invitations matched to their members", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const rows = people();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("owner@example.com");
    expect(rows[0]?.textContent).toContain("Owner");
    expect(
      rows.filter((row) => row.textContent?.includes("amy@example.com")),
    ).toHaveLength(1);
    expect(rows[2]?.textContent).toContain("bob@example.com");
    expect(rows[2]?.textContent).toContain("Not joined yet");
  });

  it("removes a member from the room through the membership, not the invitation", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const amy = people().find((row) => row.textContent?.includes("amy@"))!;
    await act(async () => {
      amy
        .querySelector<HTMLButtonElement>(
          '[aria-label="Actions for amy@example.com"]',
        )
        ?.click();
    });
    const item = (text: string) =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (element) => element.textContent === text,
      ) as HTMLElement | undefined;
    expect(item("Remove invitation")).toBeDefined();
    await act(async () => item("Remove from room")?.click());
    await vi.waitFor(() => expect(executeMutate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "revoke-member",
      subject: "u-amy",
    });
  });

  it("invites by email and clears the field once Room confirms", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const input = container!.querySelector<HTMLInputElement>(
      "#collab-allow-email",
    )!;
    await act(async () => {
      Reflect.set(
        HTMLInputElement.prototype,
        "value",
        "Carol@Example.com ",
        input,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "allow-email",
      email: "Carol@Example.com",
      role: "viewer",
    });
  });

  it("resets the link only after its consequences are confirmed", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    await act(async () => buttonWith(container!, "Reset link")?.click());
    expect(createMutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "The current link stops working and everyone is disconnected",
    );
    await confirm("Reset link");
    await vi.waitFor(() => expect(createMutate).toHaveBeenCalledOnce());
    expect(initialCapture.current?.rotate).toEqual({
      roomId: "room-a",
      expectedGeneration: 1,
    });
  });

  it("gives other members only the link and leaving", () => {
    roomGetUseQuery.mockReturnValue(managed({ role: "editor", allowlist: [] }));
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    expect(container!.querySelector("#collab-allow-email")).toBeNull();
    expect(buttonWith(container!, "Reset link")).toBeUndefined();
    expect(buttonWith(container!, "End room")).toBeUndefined();
    expect(buttonWith(container!, "Leave room")).toBeDefined();
    expect(container!.querySelector('[aria-label^="Actions for"]')).toBeNull();
  });

  it("restores a removed member's access through their membership", async () => {
    roomGetUseQuery.mockReturnValue(
      managed({
        members: [
          {
            userId: "u-dan",
            name: "dan@example.com",
            role: "editor",
            revoked: true,
            lastJoinedAt: 1,
          },
        ],
        allowlist: [],
      }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const [dan] = people();
    expect(dan?.textContent).toContain("Removed");
    await act(async () => {
      dan
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Actions for dan@example.com"]',
        )
        ?.click();
    });
    const restore = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent === "Restore access") as
      HTMLElement | undefined;
    await act(async () => restore?.click());
    await vi.waitFor(() => expect(executeMutate).toHaveBeenCalled());
    expect(executeMutate.mock.calls[0]?.[0]).toMatchObject({
      action: "set-member-role",
      subject: "u-dan",
      role: "editor",
    });
  });

  it("edits an invitation's role only while nobody has joined with it", () => {
    roomGetUseQuery.mockReturnValue(
      managed({
        members: [],
        allowlist: [
          // Joined, but the member is on another page of members.
          {
            email: "eve@example.com",
            role: "editor",
            removed: false,
            lastJoinedAt: 5,
          },
          {
            email: "fay@example.com",
            role: "viewer",
            removed: false,
            lastJoinedAt: null,
          },
        ],
      }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    expect(
      container!.querySelector('[aria-label="Role for eve@example.com"]'),
    ).toBeNull();
    expect(
      container!.querySelector('[aria-label="Role for fay@example.com"]'),
    ).not.toBeNull();
  });

  it("clears the invite field when a retried invitation is confirmed, not before", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    executeMutate.mockImplementationOnce((input) =>
      Promise.resolve({
        operationId: input.operationId,
        status: "pending",
        authRevision: 1,
        authorityEpoch: 1,
        projectionPending: false,
      }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const input = container!.querySelector<HTMLInputElement>(
      "#collab-allow-email",
    )!;
    await act(async () => {
      Reflect.set(
        HTMLInputElement.prototype,
        "value",
        "gil@example.com",
        input,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() =>
      expect(buttonWith(container!, "Retry")).toBeDefined(),
    );
    // Pending is not confirmation.
    expect(input.value).toBe("gil@example.com");
    await act(async () => buttonWith(container!, "Retry")?.click());
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(executeMutate.mock.calls[1]?.[0]).toMatchObject({ action: "query" });
  });

  it("keeps the pending invitation's address when another invite is refused", async () => {
    roomGetUseQuery.mockReturnValue(managed());
    executeMutate.mockImplementationOnce((input) =>
      Promise.resolve({
        operationId: input.operationId,
        status: "pending",
        authRevision: 1,
        authorityEpoch: 1,
        projectionPending: false,
      }),
    );
    renderDialog({ isAuthenticated: true, roomId: "room-a" });
    const input = container!.querySelector<HTMLInputElement>(
      "#collab-allow-email",
    )!;
    const submit = async (value: string) => {
      await act(async () => {
        Reflect.set(HTMLInputElement.prototype, "value", value, input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input
          .closest("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
    };
    await submit("ann@example.com");
    await vi.waitFor(() =>
      expect(buttonWith(container!, "Retry")).toBeDefined(),
    );
    // Refused while Ann's invitation is retained.
    await submit("ben@example.com");
    await act(async () => {
      Reflect.set(
        HTMLInputElement.prototype,
        "value",
        "ann@example.com",
        input,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonWith(container!, "Retry")?.click());
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it("shows role and link-access labels, not their raw values", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      roomKey: "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA" as RoomKey,
    });
    const triggers = Array.from(
      container!.querySelectorAll('[data-slot="select-value"]'),
    ).map((value) => value.textContent);
    expect(triggers).toEqual(
      expect.arrayContaining(["Invited people only", "View only", "Can edit"]),
    );
    expect(triggers).not.toContain("none");
    expect(triggers).not.toContain("viewer");
    // With its key, the link can be shared.
    expect(container!.querySelector("#collab-room-link")).not.toBeNull();
  });

  it("explains a missing key once and offers no keyless link to copy", () => {
    roomGetUseQuery.mockReturnValue(managed());
    renderDialog({
      isAuthenticated: true,
      roomId: "room-a",
      status: "missing-room-key",
      errorMessage: "This collaboration link is missing the encryption key.",
    });
    expect(container!.querySelector("#collab-room-full-link")).not.toBeNull();
    expect(container!.querySelector("#collab-room-link")).toBeNull();
    expect(container!.textContent).not.toContain(
      "This collaboration link is missing the encryption key.",
    );
    expect(container!.textContent).toContain(
      "This room's key isn't available to you here.",
    );
  });
});
