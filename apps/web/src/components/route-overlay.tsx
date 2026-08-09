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
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { cn } from "@/lib/utils";

type RouteOverlayProps = {
  children: React.ReactNode;
  titleKey: string;
  descriptionKey?: string;
  variant?: "default" | "dashboard";
};

export function RouteOverlay({
  children,
  titleKey,
  descriptionKey,
  variant = "default",
}: RouteOverlayProps) {
  const router = useRouter();
  const { t } = useStandaloneI18n();
  const closingRef = useRef(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    router.back();
  }, [router]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-label={t(titleKey)}
        className="inset-0 grid h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:inset-auto sm:top-6 sm:left-1/2 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:rounded-xl lg:w-4/5 lg:max-w-7xl"
      >
        <DialogHeader className="app-safe-header bg-popover sticky top-0 border-b py-4 pr-14 text-left">
          <DialogTitle className="text-lg leading-tight font-semibold sm:text-xl">
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription className={cn(!descriptionKey && "sr-only")}>
            {descriptionKey
              ? t(descriptionKey)
              : t("workspace.route.description")}
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "min-h-0 w-full overflow-y-auto overscroll-contain",
            variant === "default" &&
              "px-[var(--app-surface-gutter)] pt-6 pb-[max(var(--app-safe-area-bottom),1.5rem)]",
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
