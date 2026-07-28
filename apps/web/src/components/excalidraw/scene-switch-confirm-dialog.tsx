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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            Switch Workspace
          </DialogTitle>
          <DialogDescription>
            Switch from{" "}
            <span className="text-foreground text-base font-semibold">
              {fromWorkspaceName ?? "current workspace"}
            </span>{" "}
            to{" "}
            <span className="text-foreground text-base font-semibold">
              {toWorkspaceName ?? "selected workspace"}
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Button
            variant="default"
            onClick={() => onChoose("openExisting")}
            aria-label="Open existing scene in this workspace"
          >
            Open existing scene in this workspace
          </Button>
          <Button
            variant="outline"
            onClick={() => onChoose("newEmpty")}
            aria-label="Create a new empty scene"
          >
            Create a new empty scene
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
