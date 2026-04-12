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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: "loadRemote" | "keepLocal" | "saveAsNew") => void;
  isLoading?: boolean;
};

export function SceneRemoteConflictDialog({
  open,
  onOpenChange,
  onChoose,
  isLoading = false,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isLoading) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold">
            Remote changes detected
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? "Processing..."
              : "This scene was updated elsewhere while you still have local changes. Choose how to resolve the conflict."}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-start">
          <Button
            type="button"
            variant="default"
            disabled={isLoading}
            onClick={() => onChoose("loadRemote")}
          >
            Load remote version
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => onChoose("saveAsNew")}
          >
            Save local as new scene
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isLoading}
            onClick={() => onChoose("keepLocal")}
          >
            Keep local for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
