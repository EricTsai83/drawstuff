"use client";

import {
  CloudOff,
  CloudUpload,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";
import { useAppI18n } from "@/hooks/use-app-i18n";

export type UploadStatus =
  | "idle"
  | "uploading"
  | "success"
  | "error"
  | "offline";

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

  const config = getStatusConfig(status, t, errorMessage);
  const Icon = config.icon;

  return (
    <div
      className={cn(
        // desktop 和 mobile 的 visibility 設定
        "min-[728px]:pointer-events-none min-[728px]:invisible min-[1072px]:pointer-events-auto min-[1072px]:visible",
        // 基本樣式 - 使用專案的設計系統
        "flex items-center justify-center",
        "h-[36px] w-[36px] rounded-lg backdrop-blur-sm",
        "transition-colors duration-300 ease-out",
        "shadow-xs hover:shadow-sm",
        // 背景顏色 - 從配置對象獲取
        config.bgClass,
        // 互動效果
        onClick && "cursor-pointer",
        className,
      )}
      title={config.tooltip}
      onClick={onClick}
    >
      <Icon className={cn("h-4 w-4", config.iconClass)} />
    </div>
  );
}

function getStatusConfig(
  status: UploadStatus,
  t: (key: string) => string,
  errorMessage?: string,
) {
  switch (status) {
    case "idle":
      return {
        icon: CloudUpload,
        tooltip: t("app.cloudUpload.tooltip.idle"),
        bgClass: "bg-primary",
        iconClass: "text-white",
      };
    case "uploading":
      return {
        icon: Loader2,
        tooltip: t("app.cloudUpload.tooltip.uploading"),
        bgClass: "bg-primary/85 dark:bg-secondary",
        iconClass: "text-white animate-spin",
      };
    case "success":
      return {
        icon: CheckCircle2,
        tooltip: t("app.cloudUpload.tooltip.success"),
        bgClass: "bg-primary",
        iconClass: "text-white",
      };
    case "error":
      return {
        icon: AlertCircle,
        tooltip: errorMessage ?? t("app.cloudUpload.tooltip.error"),
        bgClass: "bg-destructive/85 border-destructive/30",
        iconClass: "text-white",
      };
    case "offline":
      return {
        icon: CloudOff,
        tooltip: t("app.cloudUpload.tooltip.offline"),
        bgClass: "bg-muted/30 dark:bg-muted/20",
        iconClass: "text-[#39393e] dark:text-[#b8b8b8]",
      };
  }
}
