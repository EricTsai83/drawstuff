import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppI18n } from "@/lib/i18n";
import { CopyButton } from "@/components/copy-button";
import { useRef } from "react";

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
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.share")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Link to this scene. Anyone who has this link will be able to view
            it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="link" className="sr-only">
              Link
            </Label>
            <Input ref={inputRef} id="link" defaultValue={sceneUrl} readOnly />
          </div>
          <CopyButton textToCopy={inputRef.current?.value ?? sceneUrl} />
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span role="img" aria-label="lock" className="text-yellow-400">
            🔒
          </span>
          {t("alerts.uploadedSecurly")}
        </div>
      </DialogContent>
    </Dialog>
  );
}
