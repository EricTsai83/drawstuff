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
        className="top-6 h-[calc(100dvh-1.5rem)] w-4/5 max-w-none translate-y-0 gap-0 overflow-y-auto rounded-none p-0 sm:max-w-none"
      >
        <DialogHeader
          className={cn(
            "px-6 pt-12 pb-6 text-center",
            variant === "dashboard" && "sr-only",
          )}
        >
          <DialogTitle className="text-2xl leading-tight font-semibold lg:text-3xl">
            {t(titleKey)}
          </DialogTitle>
          {descriptionKey && (
            <DialogDescription>{t(descriptionKey)}</DialogDescription>
          )}
        </DialogHeader>
        <div
          className={cn(
            "w-full px-6 pb-6",
            variant === "dashboard" && "contents",
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
