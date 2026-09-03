import { CloudOff, CloudUpload, CheckCircle2, AlertCircle } from "lucide-react";
import type { AppTranslate } from "@/lib/i18n";

export type UploadStatus =
  "idle" | "uploading" | "success" | "error" | "offline";

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
