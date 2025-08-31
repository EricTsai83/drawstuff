"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName?: string;
  onChoose: (choice: "openExisting" | "newEmpty") => void;
};

export function SceneSwitchConfirmDialog({
  open,
  onOpenChange,
  workspaceName,
  onChoose,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            切換 Workspace
          </DialogTitle>
          <DialogDescription>
            在「{workspaceName ?? "選擇的 Workspace"}」要進行哪種操作？
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Button
            variant="default"
            onClick={() => onChoose("openExisting")}
            aria-label="在該 Workspace 打開舊場景"
          >
            在該 Workspace 打開舊場景
          </Button>
          <Button
            variant="outline"
            onClick={() => onChoose("newEmpty")}
            aria-label="開一個新的空白場景"
          >
            開一個新的空白場景
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SceneSwitchConfirmDialog;
