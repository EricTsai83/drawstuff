"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye } from "lucide-react";
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
          <DialogTitle>{t("labels.share")}</DialogTitle>
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
        <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
          {/* Same icon the room dialog uses for "anyone with the link can view". */}
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          {t("share.scene.linkAccess")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
