"use client";

import {
  CloudOff,
  CloudUpload,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

export type UploadStatus =
  | "idle"
  | "pending"
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
  onSuccess?: () => void; // 成功後的回調函數
};

export function CloudUploadStatus({
  status,
  errorMessage,
  className,
  onClick,
  onSuccess,
}: CloudUploadStatusProps) {
  const config = getStatusConfig(status);

  // 監聽 success 狀態，1秒後自動變回 idle
  useEffect(() => {
    if (status === "success" && onSuccess) {
      const timer = setTimeout(() => {
        onSuccess();
      }, 1500);

      return () => clearTimeout(timer);
    }
  }, [status, onSuccess]);

  // 如果是 idle 狀態或沒有配置，則不渲染
  if (!config) {
    return null;
  }

  const Icon = config.icon;

  return (
    <div
      className={cn(
        // 基本樣式 - 使用專案的設計系統
        "flex items-center justify-center",
        "h-9 w-9 rounded-lg backdrop-blur-sm",
        "transition-all duration-300 ease-out",
        "shadow-xs hover:shadow-sm",

        // 顏色配置
        config.bgColor,
        config.borderColor,

        // 互動效果
        onClick && "cursor-pointer",

        className,
      )}
      title={getTooltipText(status, errorMessage)}
      onClick={onClick}
    >
      <Icon
        className={cn(
          "h-4 w-4 transition-all duration-300",
          config.iconColor,
          config.animation,
        )}
      />
    </div>
  );
}

// 輔助函數：獲取tooltip文字
function getTooltipText(status: UploadStatus, errorMessage?: string): string {
  switch (status) {
    case "pending":
      return "等待上傳到雲端";
    case "uploading":
      return "正在上傳到雲端";
    case "success":
      return "已同步到雲端";
    case "error":
      return errorMessage ?? "上傳失敗，點擊重試";
    case "offline":
      return "目前離線";
    default:
      return "";
  }
}

function getStatusConfig(status: UploadStatus) {
  switch (status) {
    case "idle":
      // 隱藏狀態，不顯示任何內容
      return null;

    case "pending":
      return {
        icon: CloudUpload,
        bgColor: "bg-primary",
        iconColor: "text-white",
      };

    case "uploading":
      return {
        icon: Loader2,
        bgColor: "bg-primary/85 dark:bg-secondary",
        iconColor: "text-white",
        animation: "animate-spin",
      };

    case "success":
      return {
        icon: CheckCircle2,
        bgColor: "bg-primary",
        iconColor: "text-white",
      };

    case "error":
      return {
        icon: AlertCircle,
        bgColor: "bg-destructive/85",
        iconColor: "text-white",
        borderColor: "border-destructive/30",
      };

    case "offline":
      return {
        icon: CloudOff,
        bgColor: "bg-muted/30 dark:bg-muted/20",
        iconColor: "text-[#39393e] dark:text-[#b8b8b8]",
      };

    default:
      return null;
  }
}
