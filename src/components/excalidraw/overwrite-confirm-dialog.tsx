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

export type OverwriteConfirmDialogUIProps = {
  open: boolean;
  onOpenChange?: (open: boolean) => void;

  title: React.ReactNode;
  description: React.ReactNode;
  actionLabel: string;

  onConfirm: () => void;
  onClose?: () => void;
  onExportImage?: () => void | Promise<void>;
  onSaveToDisk?: () => void | Promise<void>;
  onUploadToCloud?: () => void | Promise<void>;
};

export function OverwriteConfirmDialog(props: OverwriteConfirmDialogUIProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    actionLabel,
    onConfirm,
    onClose,
    onExportImage,
    onSaveToDisk,
    onUploadToCloud,
  } = props;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      onClose?.();
    }
    onOpenChange?.(nextOpen);
  }

  function handleConfirm() {
    onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-label="Overwrite confirm dialog" className="z-1000">
        <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        <DialogDescription className="text-muted-foreground text-sm">
          {description}
        </DialogDescription>

        <Button aria-label={actionLabel} onClick={handleConfirm}>
          {actionLabel}
        </Button>

        <DialogFooter className="sm:justify-between">
          {(onExportImage ?? onSaveToDisk ?? onUploadToCloud) && (
            <div className="-mt-1 space-y-3">
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                或選擇其他操作
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                {(onExportImage ?? null) && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Export image"
                    className="justify-start gap-2 sm:justify-center"
                    onClick={() => onExportImage?.()}
                  >
                    <ImageIcon className="h-4 w-4" /> 輸出圖片
                  </Button>
                )}
                {(onSaveToDisk ?? null) && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Save to disk"
                    className="justify-start gap-2 sm:justify-center"
                    onClick={() => onSaveToDisk?.()}
                  >
                    <Download className="h-4 w-4" /> 存入磁碟
                  </Button>
                )}
                {(onUploadToCloud ?? null) && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Upload to cloud"
                    className="justify-start gap-2 sm:justify-center"
                    onClick={() => onUploadToCloud?.()}
                  >
                    <CloudUpload className="h-4 w-4" /> 上傳雲端
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
