import Link from "next/link";
import { PanelsTopLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { StorageWarning } from "@/components/storage-warning";
import { SceneShareDialog } from "@/components/scene-share-dialog";

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

  return (
    <>
      <div className="ml-2.5 flex items-center gap-2.5">
        {showDashboardShortcut && (
          <Link
            href="/dashboard"
            aria-label="Open dashboard"
            className="focus-visible:outline-none"
          >
            <PanelsTopLeft
              className={cn(
                "flex h-9 w-9 cursor-pointer items-center justify-center rounded-full p-2",
                "bg-[#e9ecef] text-[#5c5c5c] hover:bg-[#f1f0ff]",
                "dark:bg-[#232329] dark:text-[#b8b8b8] dark:hover:bg-[#2d2d38]",
              )}
            />
          </Link>
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
