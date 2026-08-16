"use client";

import { Button } from "@/components/ui/button";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { Link } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AppTranslate } from "@/lib/i18n";
import { Spinner } from "@/components/ui/spinner";

type ShareSceneButtonProps = {
  exportStatus: ExportStatus;
  onClick: () => void;
  presentation?: "regular" | "wide" | "responsive";
};

export function getShareButtonConfig(status: ExportStatus, t: AppTranslate) {
  if (status === "exporting") {
    return {
      icon: <Spinner data-icon="inline-start" aria-hidden="true" />,
      label: t("app.export.link.loading"),
      disabled: true,
      variant: "canvas" as const,
    };
  }
  return {
    icon: <Link data-icon="inline-start" aria-hidden="true" />,
    label: t("labels.share"),
    disabled: false,
    variant: "canvas" as const,
  };
}

export function ShareSceneButton({
  exportStatus,
  onClick,
  presentation = "wide",
}: ShareSceneButtonProps) {
  const { t } = useAppI18n();
  const buttonConfig = getShareButtonConfig(exportStatus, t);
  const showResponsiveLabel = presentation === "responsive";

  return (
    <Button
      className={cn(
        "font-normal",
        presentation === "regular" && "size-9",
        presentation === "wide" && "min-w-20",
        showResponsiveLabel &&
          "canvas-wide:w-auto canvas-wide:min-w-20 canvas-wide:px-2.5 size-9",
      )}
      size={presentation === "regular" ? "canvas-icon" : "canvas"}
      variant={buttonConfig.variant}
      disabled={buttonConfig.disabled}
      onClick={onClick}
      aria-label={buttonConfig.label}
      aria-busy={buttonConfig.disabled}
    >
      {buttonConfig.icon}
      {presentation === "wide" && buttonConfig.label}
      {showResponsiveLabel && (
        <span className="canvas-wide:inline hidden">{buttonConfig.label}</span>
      )}
    </Button>
  );
}
