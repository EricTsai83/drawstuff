"use client";

import { useEffect, useState } from "react";
import { ShieldAlertIcon } from "lucide-react";

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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAdminI18n } from "@/components/admin/admin-i18n";

export type AdminConfirmation = {
  title: string;
  description: string;
  targetId: string;
  confirmLabel: string;
};

export function AdminConfirmDialog({
  confirmation,
  pending,
  onOpenChange,
  onConfirm,
}: {
  confirmation: AdminConfirmation | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useAdminI18n();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!confirmation) setValue("");
  }, [confirmation]);

  const matches = value === confirmation?.targetId;

  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="bg-destructive/10 text-destructive mb-2 flex size-10 items-center justify-center rounded-full">
            <ShieldAlertIcon aria-hidden="true" />
          </div>
          <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-confirmation">
              {t("confirm.typeTargetId")}
            </FieldLabel>
            <Input
              id="admin-confirmation"
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder={confirmation?.targetId}
              onChange={(event) => setValue(event.target.value)}
            />
            <FieldDescription className="font-mono text-xs break-all">
              {confirmation?.targetId}
            </FieldDescription>
          </Field>
        </FieldGroup>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("confirm.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!matches || pending}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmation?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
