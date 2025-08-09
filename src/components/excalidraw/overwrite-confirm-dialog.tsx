import React from "react";
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

export function OverwriteConfirmDialog({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) {
  const {
    request,
    open,
    handleOpenChange,
    handleConfirm,
    handleClose,
    handleExportImage,
    handleSaveToDisk,
    handleUploadToCloud,
  } = useOverwriteConfirm({ excalidrawAPI });

  if (!request) return null;

  const computedTitle = request.title;
  const computedDescription = request.description;
  const computedActionLabel = request.actionLabel ?? "Confirm";

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      handleClose();
    }
    handleOpenChange(nextOpen);
  }

  function handlePrimaryConfirm() {
    handleConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent aria-label="Overwrite confirm dialog" className="z-1000">
        <DialogTitle className="text-lg font-semibold">
          {computedTitle}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground text-sm">
          {computedDescription}
        </DialogDescription>

        <Button aria-label={computedActionLabel} onClick={handlePrimaryConfirm}>
          {computedActionLabel}
        </Button>

        <DialogFooter className="sm:justify-between">
          <div className="-mt-1 space-y-3">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              或選擇其他操作
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                aria-label="Export image"
                className="justify-start gap-2 sm:justify-center"
                onClick={() => handleExportImage()}
              >
                <ImageIcon className="h-4 w-4" /> 輸出圖片
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Save to disk"
                className="justify-start gap-2 sm:justify-center"
                onClick={() => handleSaveToDisk()}
              >
                <Download className="h-4 w-4" /> 存入磁碟
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Upload to cloud"
                className="justify-start gap-2 sm:justify-center"
                onClick={() => handleUploadToCloud()}
              >
                <CloudUpload className="h-4 w-4" /> 上傳雲端
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
