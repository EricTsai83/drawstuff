"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromWorkspaceName?: string;
  toWorkspaceName?: string;
  onChoose: (choice: "openExisting" | "newEmpty") => void;
};

export function SceneSwitchConfirmDialog({
  open,
  onOpenChange,
  fromWorkspaceName,
  toWorkspaceName,
  onChoose,
}: Props) {
  const { t } = useAppI18n();
  const from = fromWorkspaceName ?? t("scene.switchWorkspace.current");
  const to = toWorkspaceName ?? t("scene.switchWorkspace.selected");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {t("scene.switchWorkspace.title")}
          </DialogTitle>
          <DialogDescription>
            {t("scene.switchWorkspace.description", { from, to })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Button
            variant="default"
            onClick={() => onChoose("openExisting")}
            aria-label={t("scene.switchWorkspace.openExisting")}
          >
            {t("scene.switchWorkspace.openExisting")}
          </Button>
          <Button
            variant="outline"
            onClick={() => onChoose("newEmpty")}
            aria-label={t("scene.switchWorkspace.createEmpty")}
          >
            {t("scene.switchWorkspace.createEmpty")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
