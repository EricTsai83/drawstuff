"use client";

import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoginForm } from "@/components/login-form";
import { useAppI18n } from "@/hooks/use-app-i18n";

export default function LoginPageContent() {
  const router = useRouter();
  const { t } = useAppI18n();

  return (
    <Dialog open onOpenChange={(open) => !open && router.back()}>
      <DialogContent className="max-h-(--app-dialog-max-height) w-[calc(100%-2rem)] overflow-y-auto px-4 py-8 sm:max-w-sm">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("auth.welcome")}</DialogTitle>
          <DialogDescription>{t("auth.signIn")}</DialogDescription>
        </DialogHeader>
        <LoginForm />
      </DialogContent>
    </Dialog>
  );
}
