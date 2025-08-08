"use client";

import { Button } from "@/components/ui/button";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { Loader2, Link } from "lucide-react";
import { cn } from "@/lib/utils";

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
    icon: <Link className="h-3 w-3" />,
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
      className={cn(
        "flex items-center justify-center gap-2 font-normal whitespace-nowrap",
        "w-[12ch] transition-[width] duration-300 ease-in-out",
        // Enforce exact height 36px regardless of Button size variants
        "h-[36px] rounded-[8px]",
        {
          "w-[16ch]": exportStatus === "exporting",
        },
      )}
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
