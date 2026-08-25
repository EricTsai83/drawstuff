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

export type SignOutChoice = "save" | "discard" | "cancel";

type SignOutConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: SignOutChoice) => void;
  isLoading?: boolean;
};

export function SignOutConfirmDialog({
  open,
  onOpenChange,
  onChoose,
  isLoading = false,
}: SignOutConfirmDialogProps) {
  const { t } = useAppI18n();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isLoading) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className={CONFIRM_DIALOG_CONTENT_CLASS_NAME}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {t("auth.signOutConfirm.title")}
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? t("common.processing")
              : t("auth.signOutConfirm.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isLoading}
            onClick={() => onChoose("cancel")}
          >
            {t("buttons.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => onChoose("discard")}
          >
            {t("auth.signOutConfirm.discard")}
          </Button>
          <Button
            type="button"
            disabled={isLoading}
            onClick={() => onChoose("save")}
          >
            {t("auth.signOutConfirm.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
