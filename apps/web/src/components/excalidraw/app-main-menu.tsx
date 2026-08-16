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
import {
  SignOutConfirmDialog,
  type SignOutChoice,
} from "@/components/excalidraw/sign-out-confirm-dialog";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useCloudUpload } from "@/hooks/use-cloud-upload";
import { useSceneSession } from "@/hooks/scene-session-context";
import { api } from "@/trpc/react";
import { useCreateNewScene } from "@/hooks/excalidraw/use-create-new-scene";
import { useSceneRename } from "@/hooks/excalidraw/use-scene-rename";
import { clearCanvasForSignOut } from "@/lib/sign-out";
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
import { routes } from "@/lib/routes";
import type { CanvasProductActions } from "./canvas-product-actions";
import { ProductActionsItems } from "./main-menu/product-actions-items";
import { AdminLinkItem } from "./main-menu/admin-link-item";

type AppMainMenuProps = {
  userChosenTheme: UserChosenTheme;
  setTheme: Dispatch<SetStateAction<UserChosenTheme>>;
  langCode: string;
  onLangCodeChange: (langCode: string) => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  handleSetSceneName: (name: string) => void;
  cancelPendingSceneSave: () => void;
  sceneName: string;
  /**
   * True while a collaboration room owns the canvas — from the moment the canvas
   * is claimed, which is before the relay reports `connected`. Withholds
   * upstream's file import: it replaces the canvas through engine internals
   * without touching the scene session, so the room claim would survive and the
   * imported scene would be broadcast into the room while the room's traffic
   * reconciled into it.
   */
  isCollaborating?: boolean;
  productActions: CanvasProductActions;
  compactPresentation: boolean;
};

/**
 * Skeleton for the native `MainMenu` slot: it owns the menu composition, the
 * dialogs that must stay mounted outside the menu, and nothing else. Adding a
 * product action means adding one item component under `./main-menu/` and
 * mounting it here — see docs/architecture/native-ui-integration-contract.md.
 */
function AppMainMenu({
  userChosenTheme,
  setTheme,
  langCode,
  onLangCodeChange,
  excalidrawAPI,
  handleSetSceneName,
  cancelPendingSceneSave,
  sceneName,
  isCollaborating = false,
  productActions,
  compactPresentation,
}: AppMainMenuProps) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  // 控制 Rename / New Scene（渲染在主選單外）
  const [renameOpen, setRenameOpen] = useState(false);
  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const signOutInFlightRef = useRef(false);
  const [confirmWorkspaceId, setConfirmWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [confirmWorkspaceName, setConfirmWorkspaceName] = useState<
    string | undefined
  >(undefined);
  const { data: session } = authClient.useSession();
  const { data: adminAccess } = api.admin.access.useQuery(undefined, {
    enabled: Boolean(session?.user.id),
    retry: false,
    staleTime: 60_000,
  });
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
  const {
    currentWorkspaceId,
    isDirty,
    clearCurrentScene: clearSceneSession,
    suppressDirtyTracking,
  } = useSceneSession();
  const settingsWorkspaceId = currentWorkspaceId ?? lastActiveWorkspaceId;

  const { t } = useAppI18n();

  useMainMenuTriggerAccessibleName(t("welcomeScreen.app.menuHint"), langCode);

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

  const signOutAndClearCanvas = useCallback(async (): Promise<void> => {
    if (signOutInFlightRef.current) return;
    signOutInFlightRef.current = true;
    setIsSigningOut(true);
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            try {
              clearCanvasForSignOut({
                excalidrawAPI,
                cancelPendingSceneSave,
                clearCurrentScene: clearSceneSession,
                suppressDirtyTracking,
              });
            } finally {
              // A hard navigation releases image bytes still retained by the
              // canvas engine and resets the sign-out persistence lock.
              window.location.replace(window.location.origin);
            }
          },
        },
      });
    } finally {
      signOutInFlightRef.current = false;
      setIsSigningOut(false);
    }
  }, [
    cancelPendingSceneSave,
    clearSceneSession,
    excalidrawAPI,
    suppressDirtyTracking,
  ]);

  const hasUnsavedCanvas = useCallback((): boolean => {
    if (isDirty) return true;
    if (currentSceneId) return false;
    return (excalidrawAPI?.getSceneElements().length ?? 0) > 0;
  }, [currentSceneId, excalidrawAPI, isDirty]);

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (hasUnsavedCanvas()) {
      closeMenu();
      setSignOutConfirmOpen(true);
      return;
    }
    await signOutAndClearCanvas();
  }, [closeMenu, hasUnsavedCanvas, signOutAndClearCanvas]);

  const handleSignOutChoice = useCallback(
    async (choice: SignOutChoice): Promise<void> => {
      if (choice === "cancel") {
        setSignOutConfirmOpen(false);
        return;
      }

      setIsSigningOut(true);
      if (choice === "save") {
        const saved = await uploadSceneToCloud({
          workspaceId: currentWorkspaceId ?? lastActiveWorkspaceId,
          suppressSuccessToast: true,
        });
        if (!saved) {
          setIsSigningOut(false);
          return;
        }
      }
      await signOutAndClearCanvas();
    },
    [
      currentWorkspaceId,
      lastActiveWorkspaceId,
      signOutAndClearCanvas,
      uploadSceneToCloud,
    ],
  );

  return (
    <>
      <MainMenu>
        <div ref={menuRef} className="max-w-full overflow-x-hidden">
          {compactPresentation && <SceneTitle sceneName={sceneName} />}
          {session && (
            <WorkspaceSwitcherItem
              workspaces={workspaces}
              selectedWorkspaceId={currentWorkspaceId ?? lastActiveWorkspaceId}
              onSelect={(workspace) => {
                setConfirmWorkspaceId(workspace.id);
                setConfirmWorkspaceName(workspace.name);
                setConfirmOpen(true);
              }}
              onCreateAction={() => {
                closeMenu();
                router.push(routes.newWorkspace);
              }}
            />
          )}
          {session && compactPresentation && (
            <DashboardLinkItem
              onNavigate={closeMenu}
              workspaceId={currentWorkspaceId ?? lastActiveWorkspaceId}
            />
          )}
          {compactPresentation && (
            <RenameSceneItem onActivate={handleOpenRename} />
          )}
          {session && <NewSceneItem onActivate={handleOpenNewSceneDialog} />}
          {compactPresentation && (
            <ProductActionsItems
              actions={productActions}
              onDismiss={closeMenu}
            />
          )}

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
          {session && (
            <SettingsItem
              href={
                settingsWorkspaceId
                  ? routes.workspaceSettings(settingsWorkspaceId)
                  : undefined
              }
              onNavigate={closeMenu}
            />
          )}
          {session && adminAccess?.isOperator && (
            <AdminLinkItem onNavigate={closeMenu} />
          )}
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
            router.push(routes.dashboard(confirmWorkspaceId));
          } else if (choice === "newEmpty") {
            // 先更新最後啟用的 workspace，避免 Dialog 預設讀到舊值
            void setLastActiveWorkspace(confirmWorkspaceId).finally(() => {
              setNewSceneOpen(true);
            });
          }
        }}
      />
      <SignOutConfirmDialog
        open={signOutConfirmOpen}
        onOpenChange={setSignOutConfirmOpen}
        onChoose={(choice) => {
          void handleSignOutChoice(choice);
        }}
        isLoading={isSigningOut}
      />
    </>
  );
}

export default memo(AppMainMenu);
