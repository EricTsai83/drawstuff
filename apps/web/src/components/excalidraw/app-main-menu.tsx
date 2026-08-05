"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import {
  useRef,
  memo,
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useOutsideClick } from "@/hooks/use-outside-click";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { SceneRenameDialog } from "@/components/excalidraw/scene-rename-dialog";
import type { UserChosenTheme } from "@/hooks/use-sync-theme";
import { authClient } from "@/lib/auth/client";
import { useRouter } from "next/navigation";
import { SceneSwitchConfirmDialog } from "@/components/excalidraw/scene-switch-confirm-dialog";
import NewSceneDialog from "@/components/excalidraw/new-scene-dialog";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import WorkspaceSettingsDialog from "@/components/excalidraw/workspace-settings-dialog";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { useSceneSession } from "@/hooks/scene-session-context";
import { api } from "@/trpc/react";
import type { ConfirmDialogOptions } from "@/hooks/use-workspace-create-confirm";
import { useCreateNewScene } from "@/hooks/excalidraw/use-create-new-scene";
import { useSceneRename } from "@/hooks/excalidraw/use-scene-rename";
import { useMainMenuTriggerAccessibleName } from "./main-menu/accepted-limitation-trigger-label";
import { AccountItem } from "./main-menu/account-item";
import { DashboardLinkItem } from "./main-menu/dashboard-link-item";
import { LanguageItem } from "./main-menu/language-item";
import { NewSceneItem } from "./main-menu/new-scene-item";
import { RenameSceneItem } from "./main-menu/rename-scene-item";
import { SceneTitle } from "./main-menu/scene-title";
import { SettingsItem } from "./main-menu/settings-item";
import { SocialLinksItem } from "./main-menu/social-links-item";
import { ThemeItem } from "./main-menu/theme-item";
import { WorkspaceSwitcherItem } from "./main-menu/workspace-switcher-item";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
  langCode: string;
  onLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  handleSetSceneName: (name: string) => void;
  sceneName: string;
  showConfirmDialog?: (opts: ConfirmDialogOptions) => void;
  /**
   * True while a collaboration room owns the canvas — from the moment the canvas
   * is claimed, which is before the relay reports `connected`. Withholds
   * upstream's file import: it replaces the canvas through engine internals
   * without touching the scene session, so the room claim would survive and the
   * imported scene would be broadcast into the room while the room's traffic
   * reconciled into it.
   */
  isCollaborating?: boolean;
};

/**
 * Skeleton for the native `MainMenu` slot: it owns the menu composition, the
 * dialogs that must stay mounted outside the menu, and nothing else. Adding a
 * product action means adding one item component under `./main-menu/` and
 * mounting it here — see docs/architecture/05-native-ui-integration-contract.md.
 */
function AppMainMenu({
  userChosenTheme,
  setTheme,
  langCode,
  onLangCodeChange,
  excalidrawAPI,
  handleSetSceneName,
  sceneName,
  showConfirmDialog,
  isCollaborating = false,
}: AppMainMenuProps) {
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
  const { uploadSceneToCloud, clearCurrentScene, currentSceneId } =
    useCloudUpload(() => {
      // 若找不到場景（理論上新建時不會），忽略
    }, excalidrawAPI);
  const utils = api.useUtils();
  const setLastActiveMutation = api.workspace.setLastActive.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });
  const { workspaces, lastActiveWorkspaceId } = useWorkspaceOptions();
  const { currentWorkspaceId } = useSceneSession();

  useMainMenuTriggerAccessibleName(langCode);

  const setLastActiveWorkspace = useCallback(
    (workspaceId: string) => setLastActiveMutation.mutateAsync({ workspaceId }),
    [setLastActiveMutation],
  );

  const renameScene = useSceneRename(currentSceneId);
  const handleCreateNewScene = useCreateNewScene({
    excalidrawAPI,
    handleSetSceneName,
    clearCurrentScene,
    uploadSceneToCloud,
    setLastActiveWorkspace,
  });

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

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.refresh();
        },
      },
    });
  };

  return (
    <>
      <MainMenu>
        <div ref={menuRef} className="max-w-full overflow-x-hidden">
          <SceneTitle sceneName={sceneName} />
          {session && (
            <WorkspaceSwitcherItem
              workspaces={workspaces}
              selectedWorkspaceId={currentWorkspaceId ?? lastActiveWorkspaceId}
              onSelect={(workspace) => {
                setConfirmWorkspaceId(workspace.id);
                setConfirmWorkspaceName(workspace.name);
                setConfirmOpen(true);
              }}
              onCreateSuccess={(workspace) => {
                void setLastActiveWorkspace(workspace.id);
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
          )}
          {session && <DashboardLinkItem onNavigate={closeMenu} />}
          {session && <RenameSceneItem onActivate={handleOpenRename} />}
          {session && <NewSceneItem onActivate={handleOpenNewSceneDialog} />}

          {/* Importing a file swaps the canvas inside the engine, so the room
              claim would not be released: the imported scene would be published
              into the room and the room's traffic would reconcile into it. There
              is no defined meaning for "open a local file" as a room edit, so the
              item is withheld rather than given a surprising one. */}
          {!isCollaborating && <MainMenu.DefaultItems.LoadScene />}
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          {session && <SettingsItem onActivate={handleOpenSettings} />}
          <MainMenu.Separator />
          <AccountItem user={session?.user ?? null} onSignOut={handleSignOut} />

          <MainMenu.Separator />
          <ThemeItem userChosenTheme={userChosenTheme} setTheme={setTheme} />
          <LanguageItem
            langCode={langCode}
            onLangCodeChange={onLangCodeChange}
          />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <SocialLinksItem />
        </div>
      </MainMenu>
      {/* 將 Dialog 渲染在主選單外，避免關閉主選單時一併卸載 */}

      <SceneRenameDialog
        excalidrawAPI={excalidrawAPI}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onConfirmName={(name) => {
          handleSetSceneName(name);
          renameScene(name);
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
          workspaces.find(
            (workspace) =>
              workspace.id === (currentWorkspaceId ?? lastActiveWorkspaceId),
          )?.name
        }
        toWorkspaceName={confirmWorkspaceName}
        onChoose={(choice) => {
          setConfirmOpen(false);
          if (!confirmWorkspaceId) return;
          if (choice === "openExisting") {
            router.push(`/dashboard?workspaceId=${confirmWorkspaceId}`);
          } else if (choice === "newEmpty") {
            // 先更新最後啟用的 workspace，避免 Dialog 預設讀到舊值
            void setLastActiveWorkspace(confirmWorkspaceId).finally(() => {
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
