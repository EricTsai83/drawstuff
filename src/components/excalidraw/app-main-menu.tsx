"use client";

import { MainMenu } from "@excalidraw/excalidraw";
import {
  useRef,
  memo,
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { LanguageSelector } from "./app-language/language-selector";
import Link from "next/link";
import { Bluesky, Github, Blog } from "@/components/icons";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { SceneRenameDialog } from "@/components/excalidraw/scene-rename-dialog";
import {
  LogIn,
  FilePenLine,
  FilePlus2,
  Settings2,
  PanelsTopLeft,
} from "lucide-react";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";
import { authClient } from "@/lib/auth/client";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { SceneSwitchConfirmDialog } from "@/components/excalidraw/scene-switch-confirm-dialog";
import NewSceneDialog from "@/components/excalidraw/new-scene-dialog";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import WorkspaceSettingsDialog from "@/components/excalidraw/workspace-settings-dialog";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { ConfirmDialogOptions } from "@/hooks/use-workspace-create-confirm";
import { loadCurrentSceneIdFromStorage } from "@/data/local-storage";
import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
  langCode: string;
  onLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  handleSetSceneName: (name: string) => void;
  sceneName: string;
  showConfirmDialog?: (opts: ConfirmDialogOptions) => void;
};

const DEFAULT_ZOOM_VALUE = 1 as AppState["zoom"]["value"];

function createResetZoomState(
  currentZoom: AppState["zoom"] | undefined,
): AppState["zoom"] {
  if (
    currentZoom &&
    typeof currentZoom.value === "number" &&
    Number.isFinite(currentZoom.value)
  ) {
    return { ...currentZoom, value: DEFAULT_ZOOM_VALUE };
  }
  return { value: DEFAULT_ZOOM_VALUE };
}

function AppMainMenu({
  userChosenTheme,
  setTheme,
  langCode,
  onLangCodeChange,
  excalidrawAPI,
  handleSetSceneName,
  sceneName,
  showConfirmDialog,
}: AppMainMenuProps) {
  const { t } = useAppI18n();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  // 控制 Settings Dialog（渲染在主選單外，避免被一起卸載）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 控制 Rename / New Scene（渲染在主選單外）
  const [renameOpen, setRenameOpen] = useState(false);
  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmWorkspaceId, setConfirmWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [confirmWorkspaceName, setConfirmWorkspaceName] = useState<
    string | undefined
  >(undefined);
  const { data: session } = authClient.useSession();
  const { uploadSceneToCloud, clearCurrentSceneId, currentSceneId } =
    useCloudUpload(() => {
      // 若找不到場景（理論上新建時不會），忽略
    }, excalidrawAPI);
  const utils = api.useUtils();
  const renameSceneMutation = api.scene.renameScene.useMutation();
  const pendingRenameRef = useRef<string | undefined>(undefined);
  const setLastActiveMutation = api.workspace.setLastActive.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });
  const createWorkspaceMutation = api.workspace.create.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });
  const { workspaces, lastActiveWorkspaceId } = useWorkspaceOptions();

  const closeMenu = useCallback(() => {
    const currentAppState = excalidrawAPI?.getAppState();
    if (!currentAppState) {
      return;
    }
    excalidrawAPI?.updateScene({
      appState: {
        ...currentAppState,
        openMenu: null,
      },
    });
  }, [excalidrawAPI]);

  useOutsideClick(menuRef, closeMenu);

  const handleOpenRename = useCallback(() => {
    setRenameOpen(true);
    closeMenu();
  }, [closeMenu]);

  const handleOpenNewSceneDialog = useCallback(() => {
    setNewSceneOpen(true);
    closeMenu();
  }, [closeMenu]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
    closeMenu();
  }, [closeMenu]);

  const triggerRename = useCallback(
    (nextName: string) => {
      const effectiveId = loadCurrentSceneIdFromStorage();
      if (!effectiveId) {
        pendingRenameRef.current = nextName;
        return;
      }
      renameSceneMutation.mutate(
        { id: effectiveId, name: nextName },
        {
          onSuccess: () => {
            void utils.scene.getUserScenesInfinite.invalidate();
          },
          onError: (err) => {
            const code = (err as unknown as { data?: { code?: string } })?.data
              ?.code;
            const msg = (err as unknown as { message?: string })?.message ?? "";
            const isNotFound =
              code === "NOT_FOUND" || msg.includes("Scene not found");
            if (isNotFound) {
              void utils.scene.getUserScenesInfinite.invalidate();
              window.setTimeout(() => {
                const retryId = loadCurrentSceneIdFromStorage();
                if (!retryId) return;
                renameSceneMutation.mutate(
                  { id: retryId, name: nextName },
                  {
                    onSuccess: () => {
                      void utils.scene.getUserScenesInfinite.invalidate();
                    },
                  },
                );
              }, 300);
              return;
            }
            toast.error("Failed to update scene name. Please try again.");
          },
        },
      );
    },
    [renameSceneMutation, utils],
  );

  // 若剛拿到新 id，且有待辦改名，補送 rename
  if (currentSceneId && pendingRenameRef.current) {
    const name = pendingRenameRef.current;
    pendingRenameRef.current = undefined;
    triggerRename(name);
  }

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.refresh();
        },
      },
    });
  };

  type CreateNewSceneParams = {
    name: string;
    description?: string;
    workspaceId?: string;
    newWorkspaceName?: string;
    keepCurrentContent: boolean;
  };

  const handleCreateNewScene = useCallback(
    async ({
      name,
      description,
      workspaceId,
      newWorkspaceName,
      keepCurrentContent,
    }: CreateNewSceneParams) => {
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
            toast.info(t("toasts.newScene.localOnly"));
            return;
          }
          // 直接以目前內容建立新雲端場景，並自動關聯縮圖與資產
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            mode: "create",
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success(t("toasts.newSceneCreated"));
        } else {
          // 重置畫布為空
          const currentAppState = excalidrawAPI?.getAppState() as
            | AppState
            | undefined;
          if (currentAppState) {
            const resetZoom = createResetZoomState(currentAppState.zoom);
            excalidrawAPI?.updateScene({
              elements: [],
              appState: {
                ...currentAppState,
                zoom: resetZoom,
                name,
              },
            });
          }
          // 需求：Create 時立即做第一次儲存
          if (!session) {
            toast.info(t("toasts.newEmptyScene.localOnly"));
            return;
          }
          const ok = await uploadSceneToCloud({
            name,
            description,
            workspaceId: workspaceIdToUse,
            mode: "create",
            suppressSuccessToast: true,
          });
          if (!ok) return;
          toast.success(t("toasts.newSceneCreated"));
        }
      } catch (err) {
        console.error(err);
        toast.error((err as Error)?.message ?? t("errors.failedToCreateScene"));
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
      t,
    ],
  );

  return (
    <>
      <MainMenu>
        <div ref={menuRef} className="max-w-full overflow-x-hidden">
          <div className="mx-2 mb-2 flex w-full items-center justify-center gap-2 truncate px-2 pt-1 text-center text-xl font-bold min-[728px]:hidden">
            <div className="h-4 w-4">
              <DrawstuffLogo className="h-4 w-4" />
            </div>
            <span className="block max-w-full truncate">{sceneName}</span>
          </div>
          {session && (
            <div className="px-2 pb-3">
              <WorkspaceDropdown
                options={workspaces}
                defaultValue={lastActiveWorkspaceId}
                onChange={(workspace) => {
                  setConfirmWorkspaceId(workspace.id);
                  setConfirmWorkspaceName(workspace.name);
                  setConfirmOpen(true);
                }}
                onCreateSuccess={(workspace) => {
                  void setLastActiveMutation.mutateAsync({
                    workspaceId: workspace.id,
                  });
                  // 直接建立新場景，避免打開 Dialog 造成畫布不可點
                  void handleCreateNewScene({
                    name: "Untitled",
                    description: "",
                    workspaceId: workspace.id,
                    keepCurrentContent: false,
                  });
                }}
                showConfirmDialog={showConfirmDialog}
              />
            </div>
          )}
          {session && (
            <MainMenu.ItemCustom>
              <Link
                href="/dashboard"
                className="dropdown-menu-item dropdown-menu-item-base"
                onClick={closeMenu}
              >
                <PanelsTopLeft strokeWidth={1.5} className="h-3.5 w-3.5" />

                {t("labels.openDashboard")}
              </Link>
            </MainMenu.ItemCustom>
          )}
          {session && (
            <div
              className="dropdown-menu-item dropdown-menu-item-base"
              onClick={handleOpenRename}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                event.preventDefault();
                handleOpenRename();
              }}
            >
              <FilePenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
              {t("menu.renameScene")}
            </div>
          )}
          {session && (
            <div
              className="dropdown-menu-item dropdown-menu-item-base"
              onClick={handleOpenNewSceneDialog}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                event.preventDefault();
                handleOpenNewSceneDialog();
              }}
            >
              <FilePlus2 strokeWidth={1.5} className="h-3.5 w-3.5" />
              {t("menu.newScene")}
            </div>
          )}

          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          {session && (
            <div
              className="dropdown-menu-item dropdown-menu-item-base"
              onClick={handleOpenSettings}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                event.preventDefault();
                handleOpenSettings();
              }}
            >
              <Settings2 strokeWidth={1.5} className="h-3.5 w-3.5" />
              {t("menu.settings")}
            </div>
          )}
          <MainMenu.Separator />
          {session ? (
            <MainMenu.Item
              className="mt-0!"
              icon={
                <Avatar
                  src={session.user.image ?? ""}
                  fallback={session.user.name ?? ""}
                />
              }
              aria-label={t("auth.signOut")}
              onClick={handleSignOut}
            >
              {t("auth.signOut")}
            </MainMenu.Item>
          ) : (
            <Link href="/login" className="no-underline!">
              <MainMenu.Item
                className="mt-0!"
                icon={<LogIn strokeWidth={1.5} />}
                aria-label={t("auth.signIn")}
              >
                {t("auth.signIn")}
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
            <LanguageSelector
              value={langCode}
              onValueChange={onLangCodeChange}
            />
          </MainMenu.ItemCustom>
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <div className="flex flex-row gap-2">
            <Link
              href="https://github.com/EricTsai83/drawstuff"
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
      {/* 將 Dialog 渲染在主選單外，避免關閉主選單時一併卸載 */}

      <SceneRenameDialog
        excalidrawAPI={excalidrawAPI}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onConfirmName={(name) => {
          handleSetSceneName(name);
          triggerRename(name);
          setRenameOpen(false);
        }}
      />
      <NewSceneDialog
        open={newSceneOpen}
        onOpenChange={setNewSceneOpen}
        presetWorkspaceId={confirmWorkspaceId}
        presetContentMode={"reset"}
        onConfirm={handleCreateNewScene}
      />
      <SceneSwitchConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        fromWorkspaceName={
          workspaces.find((workspace) => workspace.id === lastActiveWorkspaceId)
            ?.name
        }
        toWorkspaceName={confirmWorkspaceName}
        onChoose={(choice) => {
          setConfirmOpen(false);
          if (!confirmWorkspaceId) return;
          if (choice === "openExisting") {
            router.push(`/dashboard?workspaceId=${confirmWorkspaceId}`);
          } else if (choice === "newEmpty") {
            // 先更新最後啟用的 workspace，避免 Dialog 預設讀到舊值
            void setLastActiveMutation
              .mutateAsync({ workspaceId: confirmWorkspaceId })
              .finally(() => {
                setNewSceneOpen(true);
              });
          }
        }}
      />
      <WorkspaceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}

export default memo(AppMainMenu);
