"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { ConfirmDialogOptions } from "@/hooks/use-workspace-create-confirm";

type GlobalConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading?: boolean;
  options: ConfirmDialogOptions;
};

export function GlobalConfirmDialog({
  open,
  onOpenChange,
  loading,
  options,
}: GlobalConfirmDialogProps) {
  const {
    title,
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    isDestructive,
    onConfirm,
  } = options;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(loading)}>
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              isDestructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            autoFocus
            disabled={Boolean(loading)}
            aria-busy={Boolean(loading)}
            onClick={(e) => {
              e.preventDefault();
              void Promise.resolve(onConfirm?.());
            }}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default GlobalConfirmDialog;
