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
  onChoose: (choice: "save" | "switch" | "cancel") => void;
  isLoading?: boolean;
};

export function SceneChangeConfirmDialog({
  open,
  onOpenChange,
  onChoose,
  isLoading = false,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            Switch scene?
          </DialogTitle>
          <DialogDescription>
            {isLoading
              ? "Processing..."
              : "Save current scene before switching to another?"}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="w-full sm:flex sm:justify-between">
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="default"
              disabled={isLoading}
              onClick={() => onChoose("save")}
              aria-label="Save, then switch"
            >
              Save, then switch
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() => onChoose("switch")}
              aria-label="Switch without saving"
            >
              Switch without saving
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={isLoading}
              onClick={() => {
                onChoose("cancel");
                onOpenChange(false);
              }}
              aria-label="Cancel"
            >
              Cancel
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
