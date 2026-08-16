"use client";

import { CloudOff, CloudUpload, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AppTranslate } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type UploadStatus =
  "idle" | "uploading" | "success" | "error" | "offline";

type CloudUploadStatusProps = {
  status: UploadStatus;
  lastUploadedTime?: Date | null;
  errorMessage?: string;
  className?: string;
  onClick?: () => void;
};

export function CloudUploadButton({
  status,
  errorMessage,
  className,
  onClick,
}: CloudUploadStatusProps) {
  const { data: session } = authClient.useSession();
  const { t } = useAppI18n();

  if (!session) {
    return null;
  }

  const config = getCloudUploadPresentation(status, t, errorMessage);

  return (
    <Button
      type="button"
      size="canvas-icon"
      variant={config.variant}
      className={cn("size-9", className)}
      title={`${config.tooltip} · ${t("canvas.actions.saveShortcut")}`}
      onClick={onClick}
      disabled={!onClick || status === "uploading"}
      aria-label={config.tooltip}
      aria-busy={status === "uploading"}
    >
      {status === "uploading" ? (
        <Spinner aria-hidden="true" />
      ) : (
        <config.icon aria-hidden="true" />
      )}
    </Button>
  );
}

export function getCloudUploadPresentation(
  status: UploadStatus,
  t: AppTranslate,
  errorMessage?: string,
) {
  switch (status) {
    case "idle":
      return {
        icon: CloudUpload,
        tooltip: t("app.cloudUpload.tooltip.idle"),
        variant: "canvas" as const,
      };
    case "uploading":
      return {
        icon: CloudUpload,
        tooltip: t("app.cloudUpload.tooltip.uploading"),
        variant: "canvas" as const,
      };
    case "success":
      return {
        icon: CheckCircle2,
        tooltip: t("app.cloudUpload.tooltip.success"),
        variant: "canvas" as const,
      };
    case "error":
      return {
        icon: AlertCircle,
        tooltip: errorMessage ?? t("app.cloudUpload.tooltip.error"),
        variant: "destructive" as const,
      };
    case "offline":
      return {
        icon: CloudOff,
        tooltip: t("app.cloudUpload.tooltip.offline"),
        variant: "canvas" as const,
      };
  }
}
