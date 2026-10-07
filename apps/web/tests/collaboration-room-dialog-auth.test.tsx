// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SnapshotHttp from "@/lib/collab/snapshot-http";
import type { SnapshotApi } from "@/lib/collab/snapshot-http";

const {
  createErrorHandler,
  createMutate,
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
  createErrorHandler: {
    current: undefined as ((error: unknown) => void) | undefined,
  },
  createMutate: vi.fn(),
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
          getActiveForScene: { invalidate: getActiveForSceneInvalidate },
        },
        client: {
          collaborationRoom: {
            setKeyCheck: { mutate: vi.fn() },
          },
        },
      }),
      collaborationRoom: {
        get: {
          useQuery: (...args: unknown[]) => {
            return { data: roomGetUseQuery(...args) ?? null };
          },
        },
        create: {
          useMutation: (options: { onError?: (error: unknown) => void }) => {
            createErrorHandler.current = options.onError;
            return { isPending: false, mutate: createMutate };
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
  onRetryJoin?: () => void;
}): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <CollaborationRoomDialog
        open
        onOpenChange={params.onOpenChange ?? (() => undefined)}
        isAuthenticated={params.isAuthenticated}
        isAuthenticationPending={params.isAuthenticationPending ?? false}
        sceneId="scene-1"
        roomId={params.roomId ?? null}
        onRoomIdChange={params.onRoomIdChange ?? (() => undefined)}
        roomKey={null}
        onRoomKeyChange={params.onRoomKeyChange ?? (() => undefined)}
        status="idle"
        failureReason={params.failureReason ?? null}
        role={null}
        errorMessage={null}
        onRetryJoin={params.onRetryJoin ?? (() => undefined)}
      />,
    );
  });
};

beforeEach(() => {
  createErrorHandler.current = undefined;
  endSuccessHandler.current = undefined;
  leaveSuccessHandler.current = undefined;
  createMutate.mockClear();
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
  it("shows no reset success or join retry for pending, then recovers the same operation on a confirmed button retry", async () => {
    roomGetUseQuery.mockReturnValue({
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

  it("creates a room normally after authentication", () => {
    renderDialog({ isAuthenticated: true });
    const startButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Start collaboration");

    expect(startButton).toBeDefined();
    act(() => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // linkRole 不再隨 create 送出：重開既有房間不得重設連結權限（plan 03 M7）。
    expect(createMutate).toHaveBeenCalledWith({ sceneId: "scene-1" });
  });

  it("turns a late unauthorized response into a useful message", () => {
    renderDialog({ isAuthenticated: true });
    const error = new TRPCClientError("UNAUTHORIZED");
    Object.defineProperty(error, "data", {
      value: { code: "UNAUTHORIZED" },
    });

    act(() => createErrorHandler.current?.(error));

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
    async (_operation, successHandler) => {
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

      await act(async () => {
        await successHandler.current?.({ enforcement: "enforced" });
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
});
