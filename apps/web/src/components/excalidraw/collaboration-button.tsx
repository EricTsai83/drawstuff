"use client";

import { Eye, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import { cn } from "@/lib/utils";

type CollaborationButtonProps = {
  status: CollaborationRoomStatus;
  isReadOnly: boolean;
  onClick: () => void;
};

const LABEL: Record<CollaborationRoomStatus, string> = {
  idle: "共編",
  preparing: "準備畫布中…",
  joining: "加入中…",
  connected: "共編中",
  disconnected: "已離線",
  unauthorized: "無法加入",
  cancelled: "已取消",
  "missing-room-key": "連結不完整",
};

/** Opens the room dialog and reflects the live room state, including the
 *  read-only badge a viewer must be able to see at a glance. */
export function CollaborationButton({
  status,
  isReadOnly,
  onClick,
}: CollaborationButtonProps) {
  const label = isReadOnly ? "僅檢視" : LABEL[status];
  return (
    <Button
      variant={status === "connected" ? "default" : "secondary"}
      className={cn(
        "min-[728px]:pointer-events-none min-[728px]:invisible min-[1072px]:pointer-events-auto min-[1072px]:visible",
        "flex h-[36px] items-center justify-center gap-2 rounded-[8px] font-normal whitespace-nowrap",
      )}
      onClick={onClick}
      aria-label={label}
      aria-busy={status === "joining" || status === "preparing"}
    >
      {isReadOnly ? <Eye className="h-3 w-3" /> : <Users className="h-3 w-3" />}
      {label}
    </Button>
  );
}
