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

type SignedOutDraftChoice = "save" | "keep" | "discard";

type SignedOutDraftDialogProps = {
  open: boolean;
  /** Scene the draft was detached from; named so its absence is clear. */
  detachedFromSceneName: string | null;
  onChoose: (choice: SignedOutDraftChoice) => void;
};

/**
 * Deliberately not dismissible: the draft must be explicitly saved as a new
 * scene, kept unsaved, or discarded. Updating the original scene is not
 * offered — it may have changed elsewhere while this canvas was signed out.
 */
export function SignedOutDraftDialog({
  open,
  detachedFromSceneName,
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
          <DialogTitle>{t("auth.signedOutDraft.title")}</DialogTitle>
          <DialogDescription>
            {detachedFromSceneName
              ? t("auth.signedOutDraft.descriptionDetached", {
                  name: detachedFromSceneName,
                })
              : t("auth.signedOutDraft.description")}
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
          <Button
            type="button"
            variant="outline"
            onClick={() => onChoose("keep")}
          >
            {t("auth.signedOutDraft.keep")}
          </Button>
          <Button type="button" onClick={() => onChoose("save")}>
            {t("auth.signedOutDraft.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
