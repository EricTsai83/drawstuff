import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
} = vi.hoisted(() => ({
  createErrorHandler: {
    current: undefined as ((error: unknown) => void) | undefined,
  },
  createMutate: vi.fn(),
  endSuccessHandler: {
    current: undefined as
      ((result: { relayEnforced: boolean }) => Promise<void>) | undefined,
  },
  getActiveForSceneInvalidate: vi.fn(() => Promise.resolve()),
  idleMutate: vi.fn(),
  leaveSuccessHandler: {
    current: undefined as
      ((result: { relayEnforced: boolean }) => Promise<void>) | undefined,
  },
  roomGetInvalidate: vi.fn(() => Promise.resolve()),
  roomGetUseQuery: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    info: vi.fn(),
    success: vi.fn(),
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
            roomGetUseQuery(...args);
            return { data: null };
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
            onSuccess?: (result: { relayEnforced: boolean }) => Promise<void>;
          }) => {
            endSuccessHandler.current = options.onSuccess;
            return idleMutation;
          },
        },
        leave: {
          useMutation: (options: {
            onSuccess?: (result: { relayEnforced: boolean }) => Promise<void>;
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
      collaborationSnapshot: {
        reset: { useMutation: () => idleMutation },
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
        failureReason={null}
        role={null}
        errorMessage={null}
        onRetryJoin={() => undefined}
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
  roomGetUseQuery.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("collaboration room authentication guard", () => {
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
        await successHandler.current?.({ relayEnforced: true });
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
