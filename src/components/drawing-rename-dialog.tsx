"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useI18n } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState, useRef, useEffect, type ReactNode } from "react";

interface DrawingRenameDialogProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  trigger?: ReactNode;
  open?: boolean;
}

export function DrawingRenameDialog({
  excalidrawAPI,
  trigger,
  open,
}: DrawingRenameDialogProps) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const [drawingName, setDrawingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 使用外部控制的 open 狀態，如果沒有提供則使用內部狀態
  const isOpen = open ?? internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    setInternalOpen(newOpen);

    if (newOpen) {
      try {
        const currentName = excalidrawAPI?.getName() ?? "";
        setDrawingName(currentName);
      } catch (error) {
        console.error("Failed to get current drawing name:", error);
        setDrawingName("");
      }
    }
  };

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newName = event.target.value;
    setDrawingName(newName);
  };

  const handleConfirm = () => {
    try {
      const currentAppState = excalidrawAPI?.getAppState();
      if (currentAppState && excalidrawAPI) {
        excalidrawAPI.updateScene({
          appState: {
            name: drawingName,
          },
        });
      }
      handleOpenChange(false);
    } catch (error) {
      console.error("Failed to update drawing name:", error);
    }
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleConfirm();
    } else if (e.key === "Escape") {
      handleClose();
    }
  };

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.select();
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}

      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-md"
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-prevent-outside-click="true"
        onEscapeKeyDown={handleClose}
        onInteractOutside={handleClose}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.fileTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("labels.fileTitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="drawing-name-input" className="sr-only">
              {t("labels.fileTitle")}
            </Label>
            <Input
              ref={inputRef}
              id="drawing-name-input"
              value={drawingName}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder={t("labels.fileTitle")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              {t("buttons.cancel")}
            </Button>
            <Button onClick={handleConfirm}>{t("buttons.confirm")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
