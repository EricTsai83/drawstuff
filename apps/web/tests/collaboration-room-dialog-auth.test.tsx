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
  toastSuccess,
  binaryApi,
} = vi.hoisted(() => ({
  findForScene: vi.fn<() => Promise<{ roomId: string } | null>>(),
  initialCapture: {
    current: undefined as Parameters<typeof RoomInitializer>[0] | undefined,
  },
  cancelCreate: vi.fn<() => Promise<void>>(),
  createMutate: vi.fn<() => Promise<{ roomId: string; roomKey: RoomKey }>>(),
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
    info: vi.fn(),
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
            execute: {
              mutate: (input: { operationId: string }) =>
                Promise.resolve({
                  operationId: input.operationId,
                  status: "enforced",
                  authRevision: 1,
                  authorityEpoch: 1,
                  projectionPending: false,
                }),
            },
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
  onRetryJoin?: () => void;
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
        sceneId="scene-1"
        getInitialElements={params.getInitialElements ?? (() => [])}
        getInitialFiles={params.getInitialFiles ?? (() => [])}
        onInitializationChange={params.onInitializationChange}
        roomId={params.roomId ?? null}
        onRoomIdChange={params.onRoomIdChange ?? (() => undefined)}
        roomKey={null}
        onRoomKeyChange={params.onRoomKeyChange ?? (() => undefined)}
        status={params.status ?? "idle"}
        failureReason={params.failureReason ?? null}
        role={null}
        errorMessage={null}
        onRetryJoin={params.onRetryJoin ?? (() => undefined)}
      />,
    );
  });
};

beforeEach(() => {
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
        .find((button) => button.textContent === "Start collaboration")
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
        .find((button) => button.textContent === "Start collaboration")
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
      button("Start collaboration").click();
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
    expect(button("Start collaboration").disabled).toBe(true);
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
    act(() => button("Reset cloud canvas...").click());
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
    expect(container?.textContent).not.toContain("Start collaboration");
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
    ).find((button) => button.textContent === "Start collaboration");

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
      ).find((button) => button.textContent === "Start collaboration");
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
      await act(async () => {
        const label =
          operation === "ending" ? "End collaboration" : "Leave collaboration";
        const button = Array.from(container!.querySelectorAll("button")).find(
          (button) => button.textContent === label,
        );
        expect(button).toBeDefined();
        button?.click();
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
});
