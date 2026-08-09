"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CloudDownload, CopyPlus, Pause } from "lucide-react";
import { useAppI18n } from "@/hooks/use-app-i18n";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: "loadRemote" | "keepLocal" | "saveAsNew") => void;
  isLoading?: boolean;
};

export function SceneRemoteConflictDialog({
  open,
  onOpenChange,
  onChoose,
  isLoading = false,
}: Props) {
  const { t } = useAppI18n();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isLoading) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold">
            {t("scene.conflict.title")}
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? t("common.processing")
              : t("scene.conflict.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Button
            type="button"
            variant="default"
            className="h-auto justify-start gap-3 px-4 py-3 whitespace-normal"
            disabled={isLoading}
            onClick={() => onChoose("loadRemote")}
          >
            <CloudDownload className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">
                {t("scene.conflict.load.title")}
              </div>
              <div className="text-xs font-normal opacity-80">
                {t("scene.conflict.load.description")}
              </div>
            </div>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start gap-3 px-4 py-3 whitespace-normal"
            disabled={isLoading}
            onClick={() => onChoose("saveAsNew")}
          >
            <CopyPlus className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">
                {t("scene.conflict.save.title")}
              </div>
              <div className="text-muted-foreground text-xs font-normal">
                {t("scene.conflict.save.description")}
              </div>
            </div>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start gap-3 px-4 py-3 whitespace-normal"
            disabled={isLoading}
            onClick={() => onChoose("keepLocal")}
          >
            <Pause className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">
                {t("scene.conflict.keep.title")}
              </div>
              <div className="text-muted-foreground text-xs font-normal">
                {t("scene.conflict.keep.description")}
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
