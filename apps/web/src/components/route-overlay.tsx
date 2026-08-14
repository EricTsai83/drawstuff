"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AppTranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type RouteOverlayProps = {
  children: React.ReactNode;
  titleKey: AppTranslationKey;
  descriptionKey?: AppTranslationKey;
  variant?: "default" | "dashboard" | "centered";
};

export function RouteOverlay({
  children,
  titleKey,
  descriptionKey,
  variant = "default",
}: RouteOverlayProps) {
  const router = useRouter();
  const { t } = useAppI18n();
  const closingRef = useRef(false);
  const isDashboard = variant === "dashboard";
  const isCentered = variant === "centered";

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    router.back();
  }, [router]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-label={t(titleKey)}
        viewportClassName="fixed inset-0 z-50 overflow-x-hidden overflow-y-auto overscroll-contain"
        className="relative top-auto left-auto mx-auto my-8 block max-h-none min-h-[calc(100dvh-4rem)] w-4/5 max-w-none translate-x-0 translate-y-0 gap-0 overflow-visible rounded-none p-0 sm:max-w-none"
      >
        <DialogHeader
          className={cn(
            isDashboard
              ? "sr-only"
              : isCentered
                ? "app-safe-header bg-popover sticky top-0 z-10 border-b px-14 pt-6 pb-4 text-center sm:pt-10"
                : "app-safe-header bg-popover sticky top-0 border-b py-4 pr-14 text-left",
          )}
        >
          <DialogTitle
            className={cn(
              isCentered
                ? "text-2xl leading-tight font-semibold lg:text-3xl"
                : !isDashboard &&
                    "text-lg leading-tight font-semibold sm:text-xl",
            )}
          >
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription
            className={cn((!descriptionKey || isCentered) && "sr-only")}
          >
            {descriptionKey
              ? t(descriptionKey)
              : t("workspace.route.description")}
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            isDashboard
              ? "contents"
              : "w-full px-[var(--app-surface-gutter)] pt-6 pb-[max(var(--app-safe-area-bottom),1.5rem)]",
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
