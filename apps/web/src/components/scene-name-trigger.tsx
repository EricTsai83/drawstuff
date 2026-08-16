"use client";

import { forwardRef } from "react";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { cn } from "@/lib/utils";

export const SceneNameTrigger = forwardRef<
  HTMLDivElement,
  {
    sceneName: string;
    isMobileSlot?: boolean;
  } & React.HTMLAttributes<HTMLDivElement>
>(({ sceneName, isMobileSlot = false, ...props }, ref) => {
  const { t } = useAppI18n();

  return (
    <div
      ref={ref}
      className={cn(
        "text-foreground focus-visible:ring-ring fixed top-8 left-16 z-10 hidden max-w-[min(12rem,calc(100vw-32rem))] min-w-0 -translate-y-1/2 cursor-pointer truncate text-lg leading-5 font-medium select-none focus-visible:ring-2",
        !isMobileSlot && "min-[1080px]:block",
      )}
      aria-label={`${t("scene.rename.tooltip")}: ${sceneName}`}
      data-testid="scene-name-trigger"
      title={t("scene.rename.tooltip")}
      role="button"
      tabIndex={0}
      {...props}
    >
      {sceneName}
    </div>
  );
});

SceneNameTrigger.displayName = "SceneNameTrigger";
