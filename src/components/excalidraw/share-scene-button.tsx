"use client";

import { Button } from "@/components/ui/button";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { Loader2, Link } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppI18n } from "@/hooks/use-app-i18n";

type ShareSceneButtonProps = {
  exportStatus: ExportStatus;
  onClick: () => void;
};

function getShareButtonConfig(status: ExportStatus, t: (k: string) => string) {
  if (status === "exporting") {
    return {
      icon: <Loader2 className="h-4 w-4 animate-spin" />,
      label: t("app.export.link.loading"),
      disabled: true,
      variant: "secondary" as const,
    };
  }
  return {
    icon: <Link className="h-3 w-3" />,
    label: t("labels.share"),
    disabled: false,
    variant: "default" as const,
  };
}

export function ShareSceneButton({
  exportStatus,
  onClick,
}: ShareSceneButtonProps) {
  const { t } = useAppI18n();
  const buttonConfig = getShareButtonConfig(exportStatus, t);

  return (
    <Button
      className={cn(
        // desktop 和 mobile 的 visibility 設定
        "min-[728px]:pointer-events-none min-[728px]:invisible min-[1072px]:pointer-events-auto min-[1072px]:visible",
        "flex items-center justify-center gap-2 font-normal whitespace-nowrap",
        "w-[12ch] transition-[width] duration-300 ease-in-out",
        // Enforce exact height 36px regardless of Button size variants
        "h-[36px] rounded-[8px]",
        {
          "w-[16ch]": exportStatus === "exporting",
        },
      )}
      variant={buttonConfig.variant}
      disabled={buttonConfig.disabled}
      onClick={onClick}
      aria-label={buttonConfig.label}
      aria-busy={buttonConfig.disabled}
    >
      {buttonConfig.icon}
      {buttonConfig.label}
    </Button>
  );
}
