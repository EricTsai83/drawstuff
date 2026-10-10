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
import { CONFIRM_DIALOG_CONTENT_CLASS_NAME } from "@/components/responsive-dialog-layout";

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
    // A decision about unsaved work: answered with a button (Escape = Cancel),
    // never by an outside click or an X that hides which choice was made.
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent
        className={CONFIRM_DIALOG_CONTENT_CLASS_NAME}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t("scene.change.title")}</DialogTitle>
          <DialogDescription>
            {isLoading ? t("common.processing") : t("scene.change.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
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
            variant="default"
            disabled={isLoading}
            onClick={() => onChoose("save")}
            aria-label={t("scene.change.save")}
          >
            {t("scene.change.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
