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

export type SignedOutDraftChoice = "save" | "discard";

type SignedOutDraftDialogProps = {
  open: boolean;
  onChoose: (choice: SignedOutDraftChoice) => void;
};

/**
 * Deliberately not dismissible: a signed-in canvas must end up bound to a
 * cloud scene or cleared, so the only ways out are the two choices.
 */
export function SignedOutDraftDialog({
  open,
  onChoose,
}: SignedOutDraftDialogProps) {
  const { t } = useAppI18n();

  return (
    <Dialog open={open}>
      <DialogContent
        className={CONFIRM_DIALOG_CONTENT_CLASS_NAME}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {t("auth.signedOutDraft.title")}
          </DialogTitle>
          <DialogDescription>
            {t("auth.signedOutDraft.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onChoose("discard")}
          >
            {t("auth.signedOutDraft.discard")}
          </Button>
          <Button type="button" onClick={() => onChoose("save")}>
            {t("auth.signedOutDraft.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
