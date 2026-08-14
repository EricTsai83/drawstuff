"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { CopyButton } from "@/components/copy-button";
import {
  FORM_DIALOG_CONTENT_CLASS_NAME,
  COPY_LINK_ROW_CLASS_NAME,
} from "@/components/responsive-dialog-layout";
import { Field, FieldLabel } from "@/components/ui/field";

type SceneShareDialogProps = {
  sceneUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SceneShareDialog({
  sceneUrl,
  open,
  onOpenChange,
}: SceneShareDialogProps) {
  const { t } = useAppI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={false}
        className={FORM_DIALOG_CONTENT_CLASS_NAME}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.share")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("share.scene.description")}
          </DialogDescription>
        </DialogHeader>
        <div className={COPY_LINK_ROW_CLASS_NAME}>
          <Field className="flex-1">
            <FieldLabel htmlFor="link" className="sr-only">
              {t("share.scene.link")}
            </FieldLabel>
            <Input id="link" value={sceneUrl} readOnly />
          </Field>
          <CopyButton textToCopy={sceneUrl} />
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span
            role="img"
            aria-label={t("share.scene.lock")}
            className="text-yellow-400"
          >
            🔒
          </span>
          {t("alerts.uploadedSecurly")}
        </div>
      </DialogContent>
    </Dialog>
  );
}
