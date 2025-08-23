"use client";

import {
  CloudOff,
  CloudUpload,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  // 根據狀態獲取對應的圖標
  function getStatusIcon() {
    switch (status) {
      case "idle":
        return CloudUpload;
      case "uploading":
        return Loader2;
      case "success":
        return CheckCircle2;
      case "error":
        return AlertCircle;
      case "offline":
        return CloudOff;
      default:
        return CloudUpload;
    }
  }

  const Icon = getStatusIcon();

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
        // 背景顏色 - 根據狀態條件設定（idle 使用原本 pending 的樣式）
        status === "idle" && "bg-primary",
        status === "uploading" && "bg-primary/85 dark:bg-secondary",
        status === "success" && "bg-primary",
        status === "error" && "bg-destructive/85",
        status === "offline" && "bg-muted/30 dark:bg-muted/20",
        // 邊框顏色 - 只有錯誤狀態需要
        status === "error" && "border-destructive/30",
        // 互動效果
        onClick && "cursor-pointer",
        className,
      )}
      title={getTooltipText(status, errorMessage)}
      onClick={onClick}
    >
      <Icon
        className={cn(
          "h-4 w-4",
          // 圖標顏色 - 根據狀態條件設定
          status === "idle" && "text-white",
          status === "uploading" && "text-white",
          status === "success" && "text-white",
          status === "error" && "text-white",
          status === "offline" && "text-[#39393e] dark:text-[#b8b8b8]",
          // 動畫效果 - 只有上傳中狀態需要旋轉
          status === "uploading" && "animate-spin",
        )}
      />
    </div>
  );
}

// 輔助函數：獲取tooltip文字
function getTooltipText(status: UploadStatus, errorMessage?: string): string {
  switch (status) {
    case "idle":
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
