"use client";

import { Button } from "@/components/ui/button";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { Loader2, Share } from "lucide-react";

type ShareSceneButtonProps = {
  exportStatus: ExportStatus;
  onClick: () => void;
};

function getShareButtonConfig(status: ExportStatus) {
  if (status === "exporting") {
    return {
      icon: <Loader2 className="h-4 w-4 animate-spin" />,
      label: "Exporting...",
      disabled: true,
      variant: "secondary" as const,
    };
  }
  return {
    icon: <Share className="h-4 w-4" />,
    label: "Share",
    disabled: false,
    variant: "default" as const,
  };
}

export function ShareSceneButton({
  exportStatus,
  onClick,
}: ShareSceneButtonProps) {
  const cfg = getShareButtonConfig(exportStatus);
  return (
    <Button
      className="flex min-w-[12ch] items-center justify-center gap-2 font-normal"
      variant={cfg.variant}
      disabled={cfg.disabled}
      onClick={onClick}
      aria-label={cfg.label}
      aria-busy={cfg.disabled}
    >
      {cfg.icon}
      {cfg.label}
    </Button>
  );
}
