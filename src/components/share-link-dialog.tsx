import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@excalidraw/excalidraw";
import { CopyButton } from "@/components/copy-button";
import { useRef } from "react";

export function ShareLinkDialog() {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="font-normal">{t("labels.share")}</Button>
      </DialogTrigger>
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-md"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.share")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Link to this drawing. Anyone who has this link will be able to view
            it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="link" className="sr-only">
              Link
            </Label>
            <Input
              ref={inputRef}
              id="link"
              defaultValue="https://excalidraw-ericts.vercel.app"
              readOnly
            />
          </div>
          <CopyButton
            textToCopy={
              inputRef.current?.value ?? "https://excalidraw-ericts.vercel.app"
            }
          />
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
