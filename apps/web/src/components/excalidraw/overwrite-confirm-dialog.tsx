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
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useOverwriteConfirm } from "@/hooks/excalidraw/use-overwrite-confirm";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { getCurrentSceneSnapshot } from "@/lib/excalidraw";
import { importFromLocalStorage } from "@/data/local-storage";
import { loadScene, openConfirmModal } from "@/lib/initialize-scene";
import { parseSharedSceneHash } from "@/lib/utils";
import { importSharedSceneFilesBySharedSceneId } from "@/lib/import-data-from-db";
import { WORKFLOW_DIALOG_CONTENT_CLASS_NAME } from "@/components/responsive-dialog-layout";

export function OverwriteConfirmDialog({
  excalidrawAPI,
  clearCurrentSceneId,
  onSceneNotFoundError,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
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
    excalidrawAPI,
    onSceneNotFoundError,
  });
  const { t } = useAppI18n();

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

  // Listen for #json=... hash changes so we can prompt before overwriting the canvas
  useEffect(() => {
    function onHashChange() {
      const parsed = parseSharedSceneHash();
      if (!parsed) return;

      const id = parsed.id;
      const privateKey = parsed.key;

      const current = getCurrentSceneSnapshot(excalidrawAPI);
      const hasCurrentScene = !!current && current.elements.length > 0;

      const proceedPromise = hasCurrentScene
        ? openConfirmModal()
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

            const localDataState = importFromLocalStorage();
            const [scene, files] = await Promise.all([
              loadScene(id, privateKey, localDataState),
              importSharedSceneFilesBySharedSceneId(id, privateKey),
            ]);

            if (excalidrawAPI) {
              excalidrawAPI.updateScene({
                elements: scene.elements,
                appState: {
                  ...(scene.appState ?? {}),
                },
              });
              const filesToAdd = Object.values(files);
              if (filesToAdd.length > 0) {
                excalidrawAPI.addFiles(filesToAdd);
              }
            }
          } catch (e) {
            console.error("透過 URL 載入場景失敗:", e);
          } finally {
            window.history.replaceState(
              {},
              "Excalidraw X Ericts",
              window.location.origin,
            );
          }
        })
        .catch(() => {
          window.history.replaceState(
            {},
            "Excalidraw X Ericts",
            window.location.origin,
          );
        });
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [excalidrawAPI, clearCurrentSceneId]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        aria-label={t("overwriteConfirm.modal.shareableLink.title")}
        className={WORKFLOW_DIALOG_CONTENT_CLASS_NAME}
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
            <ImageIcon data-icon="inline-start" aria-hidden="true" />
            {t("overwriteConfirm.action.exportToImage.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={t("overwriteConfirm.action.saveToDisk.button")}
            className="justify-start gap-4 sm:min-w-40 sm:justify-center sm:gap-2"
            onClick={() => handleSaveToDisk()}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            {t("overwriteConfirm.action.saveToDisk.button")}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={t("app.overwriteConfirm.action.uploadToCloud.button")}
            className="justify-start gap-4 sm:min-w-40 sm:justify-center sm:gap-2"
            onClick={() => handleUploadToCloud()}
          >
            <CloudUpload data-icon="inline-start" aria-hidden="true" />
            {t("app.overwriteConfirm.action.uploadToCloud.button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
