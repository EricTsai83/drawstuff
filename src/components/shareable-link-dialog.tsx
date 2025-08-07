import { useRef, useState } from "react";
import { CopyIcon } from "lucide-react";
import { copyTextToSystemClipboard } from "@/lib/utils";
import { useCopyStatus } from "@/hooks/use-copied-indicator";
import { useI18n } from "@excalidraw/excalidraw";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ShareableLinkDialogProps = {
  link: string;
  onCloseRequest: () => void;
  setErrorMessage: (error: string) => void;
};

export const ShareableLinkDialog = ({
  link,
  onCloseRequest,
  setErrorMessage,
}: ShareableLinkDialogProps) => {
  const { t } = useI18n();
  const [, setJustCopied] = useState(false);
  const timerRef = useRef<number>(0);
  const ref = useRef<HTMLInputElement>(null);

  const copyRoomLink = async () => {
    try {
      await copyTextToSystemClipboard(link);
    } catch (error) {
      setErrorMessage(t("errors.copyToSystemClipboardFailed"));
    }
    setJustCopied(true);

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 3000);

    ref.current?.select();
  };

  const { onCopy, copyStatus } = useCopyStatus();

  return (
    <Dialog open onOpenChange={onCloseRequest}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Shareable link</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              ref={ref}
              readOnly
              value={link ?? ""}
              className="flex-1"
              onFocus={(e) => e.target.select()}
            />
            <Button
              size="lg"
              onClick={async () => {
                onCopy();
                await copyRoomLink();
              }}
              disabled={copyStatus === "success"}
            >
              <CopyIcon className="size-4" />
              {t("buttons.copyLink")}
            </Button>
          </div>
          <div className="text-muted-foreground text-sm">
            🔒 {t("alerts.uploadedSecurly")}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
