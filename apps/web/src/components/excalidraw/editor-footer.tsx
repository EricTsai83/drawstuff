import { cn } from "@/lib/utils";
import { StorageWarning } from "@/components/storage-warning";
import { SceneShareDialog } from "@/components/scene-share-dialog";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { DashboardLinkButton } from "@/components/excalidraw/dashboard-link-button";

type Props = {
  showDesktopActions: boolean;
  showDashboardShortcut: boolean;
  latestShareableLink?: string | null;
  isShareDialogOpen: boolean;
  onShareDialogOpenChange: (open: boolean) => void;
  workspaceId?: string;
};

export function EditorFooter(props: Props) {
  const {
    showDesktopActions,
    showDashboardShortcut,
    latestShareableLink,
    isShareDialogOpen,
    onShareDialogOpenChange,
    workspaceId,
  } = props;

  const { t } = useAppI18n();
  return (
    <>
      {showDesktopActions && (
        <div className="ml-2.5 flex items-center gap-2.5">
          {showDashboardShortcut && (
            <DashboardLinkButton
              ariaLabel={t("labels.openDashboard")}
              workspaceId={workspaceId}
            />
          )}
          <StorageWarning
            className={cn(
              "flex h-9 items-center justify-center rounded-[10px] p-2.5",
              "bg-secondary text-secondary-foreground hover:bg-muted",
            )}
          />
        </div>
      )}

      {latestShareableLink && (
        <SceneShareDialog
          sceneUrl={latestShareableLink}
          open={isShareDialogOpen}
          onOpenChange={onShareDialogOpenChange}
        />
      )}
    </>
  );
}
