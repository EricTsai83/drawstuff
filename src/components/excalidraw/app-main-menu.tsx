"use client";

import { MainMenu } from "@excalidraw/excalidraw";
import {
  useRef,
  memo,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { LanguageList } from "./app-language/language-list";
import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { SceneRenameDialog } from "@/components/excalidraw/scene-rename-dialog";
import { LogIn, FilePenLine, FilePlus2 } from "lucide-react";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";
import { authClient } from "@/lib/auth/client";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { WorkspaceSelector } from "./workspace-selector";
import NewSceneDialog from "@/components/excalidraw/new-scene-dialog";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { api } from "@/trpc/react";
import { toast } from "sonner";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
  handleLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  handleSetSceneName: (name: string) => void;
};

function AppMainMenu({
  userChosenTheme,
  setTheme,
  handleLangCodeChange,
  excalidrawAPI,
  handleSetSceneName,
}: AppMainMenuProps) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const { data: session } = authClient.useSession();
  const { uploadSceneToCloud, clearCurrentSceneId } = useCloudUpload(() => {
    // 若找不到場景（理論上新建時不會），忽略
  }, excalidrawAPI);
  const utils = api.useUtils();
  const setLastActiveMutation = api.workspace.setLastActive.useMutation();
  const createWorkspaceMutation = api.workspace.create.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });

  useOutsideClick(menuRef, () => {
    const currentAppState = excalidrawAPI?.getAppState();
    if (currentAppState) {
      excalidrawAPI?.updateScene({
        appState: {
          ...currentAppState,
          openMenu: null,
        },
      });
    }
  });

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.refresh();
        },
      },
    });
  };

  const handleCreateNewScene = useCallback(
    async ({
      name,
      description,
      workspaceId,
      newWorkspaceName,
      keepCurrentContent,
    }: {
      name: string;
      description?: string;
      workspaceId?: string;
      newWorkspaceName?: string;
      keepCurrentContent: boolean;
    }) => {
      try {
        // 更新場景名稱（不論保留或重置）
        handleSetSceneName(name);

        // 先決定要使用的 workspaceId（若有 newWorkspaceName，避免重複名稱）
        let workspaceIdToUse: string | undefined = workspaceId;
        if (!workspaceIdToUse) {
          const trimmedName = (newWorkspaceName ?? "").trim();
          if (trimmedName.length > 0) {
            const existing =
              utils.workspace.listWithMeta.getData()?.workspaces ?? [];
            const matched = existing.find(
              (w) => w.name.trim().toLowerCase() === trimmedName.toLowerCase(),
            );
            if (matched) {
              workspaceIdToUse = matched.id;
            } else {
              const created = await createWorkspaceMutation.mutateAsync({
                name: trimmedName,
              });
              workspaceIdToUse = created.id;
            }
          }
        }

        // 更新最後啟用 workspace（若選擇或新建）
        if (workspaceIdToUse) {
          await setLastActiveMutation.mutateAsync({
            workspaceId: workspaceIdToUse,
          });
        }

        // 新建場景的語義：清除 currentSceneId，避免覆寫既有場景
        clearCurrentSceneId();

        if (keepCurrentContent) {
          if (!session) {
            toast.info(
              "New scene ready (local only). Sign in to save to cloud.",
            );
            return;
          }
          // 直接以目前內容建立新雲端場景，並自動關聯縮圖與資產
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success("New scene created");
        } else {
          // 重置畫布為空
          const currentAppState = excalidrawAPI?.getAppState();
          if (currentAppState) {
            excalidrawAPI?.updateScene({
              elements: [],
              appState: {
                // 明確帶入必填 zoom 結構，避免型別不相容
                ...currentAppState,
                zoom: currentAppState.zoom,
                name,
              },
            });
          }
          // 需求：Create 時立即做第一次儲存
          if (!session) {
            toast.info(
              "New empty scene ready (local only). Sign in to save to cloud.",
            );
            return;
          }
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success("New scene created");
        }
      } catch (err) {
        console.error(err);
        toast.error((err as Error)?.message ?? "Failed to create scene");
      }
    },
    [
      clearCurrentSceneId,
      excalidrawAPI,
      handleSetSceneName,
      setLastActiveMutation,
      utils,
      createWorkspaceMutation,
      uploadSceneToCloud,
      session,
    ],
  );

  return (
    <MainMenu>
      <div ref={menuRef} className="max-w-full overflow-x-hidden">
        {session && (
          <div className="px-2 pb-3">
            <WorkspaceSelector />
          </div>
        )}
        <SceneRenameDialog
          excalidrawAPI={excalidrawAPI}
          trigger={
            <div className="dropdown-menu-item dropdown-menu-item-base">
              <FilePenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
              Rename Scene
            </div>
          }
          onConfirmName={handleSetSceneName}
        />
        <NewSceneDialog
          trigger={
            <div className="dropdown-menu-item dropdown-menu-item-base">
              <FilePlus2 strokeWidth={1.5} className="h-3.5 w-3.5" />
              New Scene
            </div>
          }
          onConfirm={handleCreateNewScene}
        />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        {session ? (
          <MainMenu.Item
            className="!mt-0"
            icon={
              <Avatar
                src={session.user.image ?? ""}
                fallback={session.user.name ?? ""}
              />
            }
            aria-label="Sign out"
            onClick={handleSignOut}
          >
            Sign out
          </MainMenu.Item>
        ) : (
          <Link href="/login" className="!no-underline">
            <MainMenu.Item
              className="!mt-0"
              icon={<LogIn strokeWidth={1.5} />}
              aria-label="Sign in"
            >
              Sign in
            </MainMenu.Item>
          </Link>
        )}

        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme
          allowSystemTheme
          theme={userChosenTheme}
          onSelect={setTheme}
        />
        <MainMenu.ItemCustom>
          <LanguageList handleLangCodeChange={handleLangCodeChange} />
        </MainMenu.ItemCustom>
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <div className="flex flex-row gap-2">
          <Link
            href="https://github.com/EricTsai83/excalidraw-ericts"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Github />
            </div>
          </Link>
          <Link
            href="https://bsky.app/profile/ericts.com"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Bluesky />
            </div>
          </Link>
          <Link
            href="https://ericts.com"
            target="_blank"
            rel="noopener"
            className="dropdown-menu-item dropdown-menu-item-base"
          >
            <div className="flex w-full justify-center">
              <Blog />
            </div>
          </Link>
        </div>
      </div>
    </MainMenu>
  );
}

export default memo(AppMainMenu);
