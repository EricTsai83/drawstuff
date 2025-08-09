import React, { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Image as ImageIcon, CloudUpload } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useOverwriteConfirm } from "@/hooks/excalidraw/use-overwrite-confirm";
import { useAppI18n } from "@/lib/i18n";
import { getCurrentSceneSnapshot } from "@/lib/excalidraw";
import { importFromLocalStorage } from "@/data/local-storage";
import { loadScene, openConfirmModal } from "@/lib/initialize-scene";

export function OverwriteConfirmDialog({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) {
  const {
    open,
    handleOpenChange,
    handleConfirm,
    handleClose,
    handleExportImage,
    handleSaveToDisk,
    handleUploadToCloud,
  } = useOverwriteConfirm({ excalidrawAPI });
  const { t, langCode } = useAppI18n();

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      handleClose();
    }
    handleOpenChange(nextOpen);
  }

  function handlePrimaryConfirm() {
    handleConfirm();
  }

  // Listen for #json=... hash changes so we can prompt using i18n within Excalidraw context
  useEffect(() => {
    function onHashChange() {
      const match = /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/.exec(
        window.location.hash,
      );
      if (!match) return;

      const current = getCurrentSceneSnapshot(excalidrawAPI);
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
              "我先隨便取的APP_NAME",
              window.location.origin,
            );
            return;
          }

          try {
            const localDataState = importFromLocalStorage();
            const scene = await loadScene(match[1], match[2], localDataState);

            if (excalidrawAPI) {
              excalidrawAPI.updateScene({
                elements: scene.elements,
                appState: {
                  ...(scene.appState ?? {}),
                  // @ts-expect-error: supported at runtime
                  scrollToContent: true,
                },
                files: scene.files,
              });
            }
          } catch (e) {
            console.error("透過 URL 載入場景失敗:", e);
          } finally {
            window.history.replaceState(
              {},
              "我先隨便取的APP_NAME",
              window.location.origin,
            );
          }
        })
        .catch(() => {
          window.history.replaceState(
            {},
            "我先隨便取的APP_NAME",
            window.location.origin,
          );
        });
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [excalidrawAPI, t, langCode]);

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
