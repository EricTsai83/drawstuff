import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createErrorHandler,
  createMutate,
  idleMutate,
  roomGetUseQuery,
  toastError,
} = vi.hoisted(() => ({
  createErrorHandler: {
    current: undefined as ((error: unknown) => void) | undefined,
  },
  createMutate: vi.fn(),
  idleMutate: vi.fn(),
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
  const { translateApp } = await vi.importActual<{
    translateApp: (
      langCode: string,
      key: string,
      values?: Record<string, string | number>,
    ) => string;
  }>("@/lib/i18n-shared");
  return {
    useAppI18n: () => ({
      langCode: "en",
      t: (key: string, values?: Record<string, string | number>) =>
        translateApp("en", key, values),
    }),
  };
});

vi.mock("@/trpc/react", () => {
  const idleMutation = { isPending: false, mutate: idleMutate };
  return {
    api: {
      useUtils: () => ({
        collaborationRoom: {
          get: { invalidate: vi.fn() },
          getActiveForScene: { invalidate: vi.fn() },
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
        end: { useMutation: () => idleMutation },
        leave: { useMutation: () => idleMutation },
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

import { CollaborationRoomDialog } from "@/components/excalidraw/collaboration-room-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const renderDialog = (params: {
  isAuthenticated: boolean;
  isAuthenticationPending?: boolean;
  roomId?: string | null;
}): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <CollaborationRoomDialog
        open
        onOpenChange={() => undefined}
        isAuthenticated={params.isAuthenticated}
        isAuthenticationPending={params.isAuthenticationPending ?? false}
        sceneId="scene-1"
        roomId={params.roomId ?? null}
        onRoomIdChange={() => undefined}
        roomKey={null}
        onRoomKeyChange={() => undefined}
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
  createMutate.mockClear();
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
      { roomId: "room-from-link" },
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
    expect(createMutate).toHaveBeenCalledWith({
      sceneId: "scene-1",
      linkRole: "none",
    });
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
