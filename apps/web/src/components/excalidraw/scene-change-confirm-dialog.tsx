"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: "save" | "switch" | "cancel") => void;
  isLoading?: boolean;
};

export function SceneChangeConfirmDialog({
  open,
  onOpenChange,
  onChoose,
  isLoading = false,
}: Props) {
  const { t } = useAppI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {t("scene.change.title")}
          </DialogTitle>
          <DialogDescription>
            {isLoading ? t("common.processing") : t("scene.change.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="w-full sm:flex sm:justify-between">
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="default"
              disabled={isLoading}
              onClick={() => onChoose("save")}
              aria-label={t("scene.change.save")}
            >
              {t("scene.change.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() => onChoose("switch")}
              aria-label={t("scene.change.discard")}
            >
              {t("scene.change.discard")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={isLoading}
              onClick={() => {
                onChoose("cancel");
                onOpenChange(false);
              }}
              aria-label={t("buttons.cancel")}
            >
              {t("buttons.cancel")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
