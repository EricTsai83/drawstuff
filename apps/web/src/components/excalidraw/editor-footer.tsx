import { cn } from "@/lib/utils";
import { StorageWarning } from "@/components/storage-warning";
import { SceneShareDialog } from "@/components/scene-share-dialog";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { DashboardLinkButton } from "@/components/excalidraw/dashboard-link-button";

type Props = {
  showDashboardShortcut: boolean;
  latestShareableLink?: string | null;
  isShareDialogOpen: boolean;
  onShareDialogOpenChange: (open: boolean) => void;
};

export function EditorFooter(props: Props) {
  const {
    showDashboardShortcut,
    latestShareableLink,
    isShareDialogOpen,
    onShareDialogOpenChange,
  } = props;

  const { t } = useStandaloneI18n();
  return (
    <>
      <div className="ml-2.5 flex items-center gap-2.5">
        {showDashboardShortcut && (
          <DashboardLinkButton ariaLabel={t("labels.openDashboard")} />
        )}
        <StorageWarning
          className={cn(
            "flex h-9 items-center justify-center rounded-[10px] p-2.5",
            "bg-[#e9ecef] hover:bg-[#f1f0ff]",
            "dark:bg-[#232329] dark:hover:bg-[#2d2d38]",
          )}
        />
      </div>

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
