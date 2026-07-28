"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CloudDownload, CopyPlus, Pause } from "lucide-react";

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
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onInteractOutside={(e) => {
          if (isLoading) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isLoading) e.preventDefault();
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold">
            Remote changes detected
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? "Processing..."
              : "This scene was updated elsewhere while you still have local changes."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Button
            type="button"
            variant="default"
            className="h-auto whitespace-normal justify-start gap-3 px-4 py-3"
            disabled={isLoading}
            onClick={() => onChoose("loadRemote")}
          >
            <CloudDownload className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">Load remote version</div>
              <div className="text-xs font-normal opacity-80">
                Discard local changes and use the latest remote version
              </div>
            </div>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto whitespace-normal justify-start gap-3 px-4 py-3"
            disabled={isLoading}
            onClick={() => onChoose("saveAsNew")}
          >
            <CopyPlus className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">Save local as new scene</div>
              <div className="text-muted-foreground text-xs font-normal">
                Keep both versions by saving your local changes as a new scene
              </div>
            </div>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto whitespace-normal justify-start gap-3 px-4 py-3"
            disabled={isLoading}
            onClick={() => onChoose("keepLocal")}
          >
            <Pause className="size-4 shrink-0" />
            <div className="min-w-0 text-left">
              <div className="text-sm font-medium">Keep local for now</div>
              <div className="text-muted-foreground text-xs font-normal">
                Continue editing locally; you can sync later
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
