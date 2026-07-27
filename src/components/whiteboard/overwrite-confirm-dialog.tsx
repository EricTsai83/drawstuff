import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Image as ImageIcon, CloudUpload } from "lucide-react";
import type { WhiteboardEngine } from "@/features/whiteboard";
import { useOverwriteConfirm } from "@/hooks/whiteboard/use-overwrite-confirm";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { getCurrentSceneSnapshot } from "@/lib/whiteboard";
import { openConfirmModal } from "@/lib/initialize-scene";
import { parseSharedSceneHash } from "@/lib/utils";
import {
  importDataFromBackend,
  importSharedSceneFilesBySharedSceneId,
} from "@/lib/import-data-from-db";
import { toast } from "sonner";

export function OverwriteConfirmDialog({
  engine,
  clearCurrentSceneId,
  onSceneNotFoundError,
}: {
  engine: WhiteboardEngine | null;
  clearCurrentSceneId: () => void;
  onSceneNotFoundError?: () => void;
}) {
  const {
    open,
    handleOpenChange,
    handleConfirm,
    handleClose,
    handleExportImage,
    handleSaveToDisk,
    handleUploadToCloud,
  } = useOverwriteConfirm({
    engine,
    onSceneNotFoundError,
  });
  const { t, langCode } = useStandaloneI18n();

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      handleClose();
    }
    handleOpenChange(nextOpen);
  }

  function handlePrimaryConfirm() {
    // 清除 localStorage 中的當前場景 ID，讓場景視為完全新的場景
    clearCurrentSceneId();
    handleConfirm();
  }

  // Listen for #json=... changes so links opened after mount use the same
  // canonical shared-document loader as initial loading.
  useEffect(() => {
    function onHashChange() {
      const parsed = parseSharedSceneHash();
      if (!parsed) return;

      const id = parsed.id;
      const privateKey = parsed.key;

      const current = getCurrentSceneSnapshot(engine);
      const hasCurrentScene = !!current && current.elements.length > 0;

      const shareableLinkConfirmDialog = {
        title: t("overwriteConfirm.modal.shareableLink.title"),
        description: t("app.overwriteConfirm.modal.shareableLink.description"),
        actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
      } as const;

      const proceedPromise = hasCurrentScene
        ? openConfirmModal(shareableLinkConfirmDialog)
        : Promise.resolve(true);

      proceedPromise
        .then(async (ok) => {
          if (!ok) {
            window.history.replaceState(
              {},
              document.title,
              window.location.origin,
            );
            return;
          }

          try {
            // 清除 localStorage 中的當前場景 ID，讓導入的場景視為完全新的場景
            clearCurrentSceneId();

            const [scene, files] = await Promise.all([
              importDataFromBackend(id, privateKey),
              importSharedSceneFilesBySharedSceneId(id, privateKey),
            ]);

            if (!scene) {
              toast.error("Could not load the shared scene.");
            } else if (engine) {
              engine.loadDocument({
                ...scene,
                assets: { ...scene.assets, ...files },
              });
            }
          } catch (e) {
            console.error("透過 URL 載入場景失敗:", e);
          } finally {
            window.history.replaceState(
              {},
              "Drawstuff",
              window.location.origin,
            );
          }
        })
        .catch(() => {
          window.history.replaceState({}, "Drawstuff", window.location.origin);
        });
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [engine, t, langCode, clearCurrentSceneId]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        aria-label={t("overwriteConfirm.modal.shareableLink.title")}
        className="z-1000 sm:max-w-xl md:max-w-2xl"
      >
        <DialogTitle className="text-lg font-semibold">
          {t("overwriteConfirm.modal.shareableLink.title")}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground mb-2 text-sm">
          {t("app.overwriteConfirm.modal.shareableLink.description")}
        </DialogDescription>

        <Button
          variant="destructive"
          aria-label={t("overwriteConfirm.modal.shareableLink.button")}
          onClick={handlePrimaryConfirm}
        >
          {t("overwriteConfirm.modal.shareableLink.button")}
        </Button>

        <DialogFooter className="w-full sm:flex sm:justify-between">
          <Button
            type="button"
            variant="outline"
            aria-label={t("overwriteConfirm.action.exportToImage.button")}
            className="justify-start gap-4 sm:min-w-40 sm:justify-center sm:gap-2"
            onClick={() => handleExportImage()}
          >
            <ImageIcon className="h-4 w-4" />
            {t("overwriteConfirm.action.exportToImage.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={t("overwriteConfirm.action.saveToDisk.button")}
            className="justify-start gap-4 sm:min-w-40 sm:justify-center sm:gap-2"
            onClick={() => handleSaveToDisk()}
          >
            <Download className="h-4 w-4" />
            {t("overwriteConfirm.action.saveToDisk.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={t("app.overwriteConfirm.action.uploadToCloud.button")}
            className="justify-start gap-4 sm:min-w-40 sm:justify-center sm:gap-2"
            onClick={() => handleUploadToCloud()}
          >
            <CloudUpload className="h-4 w-4" />
            {t("app.overwriteConfirm.action.uploadToCloud.button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
