import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastError, deleteMutate } = vi.hoisted(() => ({
  toastError: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock("@/hooks/use-standalone-i18n", async () => {
  const { translateApp } = await vi.importActual<{
    translateApp: (
      langCode: string,
      key: string,
      values?: Record<string, string | number>,
    ) => string;
  }>("@/lib/i18n-shared");
  return {
    useStandaloneI18n: () => ({
      langCode: "en",
      t: (key: string, values?: Record<string, string | number>) =>
        translateApp("en", key, values),
    }),
  };
});

vi.mock("@/hooks/scene-session-context", () => ({
  useSceneSession: () => ({
    currentSceneId: undefined,
    clearCurrentScene: vi.fn(),
    updateLastSyncedRevision: vi.fn(),
    updateCurrentWorkspaceId: vi.fn(),
  }),
}));

vi.mock("@/components/scene-edit-dialog", () => ({
  SceneEditDialog: () => null,
}));

vi.mock("@/components/scene-card-menu", () => ({
  SceneCardMenu: ({
    onAction,
  }: {
    onAction: (action: string, e: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="menu-delete"
      onClick={(e) => onAction("delete", e)}
    >
      menu-delete
    </button>
  ),
}));

vi.mock("@/components/overflow-tooltip", () => ({
  OverflowTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: () => null,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  // 接上 onOpenChange，讓測試能驗證「失敗後 dialog 仍可實際關閉」的路徑
  AlertDialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div data-testid="delete-dialog">
        {children}
        <button
          type="button"
          data-testid="dialog-close"
          onClick={() => onOpenChange(false)}
        >
          close
        </button>
      </div>
    ) : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogCancel: ({
    disabled,
    children,
  }: {
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <button type="button" data-testid="delete-cancel" disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogAction: ({
    onClick,
    disabled,
    children,
  }: {
    onClick?: () => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <button
      type="button"
      data-testid="delete-confirm"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/trpc/react", () => {
  const idleMutation = { isPending: false, mutateAsync: vi.fn() };
  return {
    api: {
      useUtils: () => ({
        scene: {
          getUserScenesInfinite: { invalidate: vi.fn() },
          getScene: { invalidate: vi.fn(), fetch: vi.fn() },
        },
        workspace: { listWithMeta: { invalidate: vi.fn() } },
        category: { list: { invalidate: vi.fn() } },
      }),
      scene: {
        saveScene: { useMutation: () => idleMutation },
        moveToWorkspace: { useMutation: () => idleMutation },
        publish: { useMutation: () => idleMutation },
        unpublish: { useMutation: () => idleMutation },
        archive: { useMutation: () => idleMutation },
        unarchive: { useMutation: () => idleMutation },
        deleteScene: {
          useMutation: (options: { onError?: (error: unknown) => void }) => ({
            isPending: false,
            mutate: (input: unknown) => {
              deleteMutate(input);
              // 模擬 server 刪除失敗：同步觸發 onError，isPending 維持 false
              options.onError?.(new Error("delete failed"));
            },
          }),
        },
      },
      category: {
        assignToScene: { useMutation: () => idleMutation },
        unassignFromScene: { useMutation: () => idleMutation },
      },
    },
  };
});

import { SceneCard } from "@/components/scene-card";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  id: "scene-1",
  name: "My scene",
  description: "",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  revision: 1,
  workspaceId: undefined,
  workspaceName: undefined,
  thumbnail: undefined,
  isArchived: false,
  isPublished: false,
  publishedSlug: undefined,
  publishedAt: undefined,
  categories: [],
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.clearAllMocks();
});

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SceneCard delete failure", () => {
  it("keeps the confirmation dialog usable and shows a toast when delete fails", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SceneCard item={item} workspaces={[]} categories={undefined} />,
      );
    });

    // 開啟刪除確認對話框（lazy render：開啟前不存在）
    expect(document.querySelector('[data-testid="delete-dialog"]')).toBeNull();
    click(document.querySelector('[data-testid="menu-delete"]'));
    expect(
      document.querySelector('[data-testid="delete-dialog"]'),
    ).not.toBeNull();

    // 確認刪除 → mutation 失敗
    click(document.querySelector('[data-testid="delete-confirm"]'));

    expect(deleteMutate).toHaveBeenCalledWith({ id: "scene-1" });
    expect(toastError).toHaveBeenCalledWith(
      "Failed to delete scene. Try again.",
    );

    // 對話框仍在且未被鎖死：Cancel 與 Action 都必須是可點擊狀態
    expect(
      document.querySelector('[data-testid="delete-dialog"]'),
    ).not.toBeNull();
    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="delete-cancel"]',
    );
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="delete-confirm"]',
    );
    expect(cancel?.disabled).toBe(false);
    expect(confirm?.disabled).toBe(false);

    // 失敗後 dialog 必須能實際關閉（onOpenChange 路徑）
    click(document.querySelector('[data-testid="dialog-close"]'));
    expect(document.querySelector('[data-testid="delete-dialog"]')).toBeNull();
  });
});
