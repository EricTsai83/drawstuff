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
  // Deliberately not "共編中": the session is connected but the canvas is too
  // large to publish, and this label is the always-visible half of saying so.
  "sync-blocked": "同步已停止",
  reconnecting: "重新連線中…",
  failed: "連線已停止",
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
  // A stopped sync outranks the read-only badge in the *visible* label, and a
  // demoted editor is exactly why: the block is latched on the session, so it
  // survives the reconnect a role change forces, and the user is left holding work
  // that can now never be published. "僅檢視" would state the lesser half of that.
  const label =
    status === "sync-blocked" || !isReadOnly ? LABEL[status] : "僅檢視";
  // The accessible name cannot make the same trade. `aria-label` replaces the
  // element's content, and the icon carries no text, so a read-only session whose
  // label was taken over by the block would lose "僅檢視" entirely for assistive
  // technology. Both facts go in the name; only the on-screen label is abridged.
  const accessibleLabel =
    isReadOnly && label !== "僅檢視" ? `${label}（僅檢視）` : label;
  return (
    <Button
      variant={status === "connected" ? "default" : "secondary"}
      className={cn(
        "min-[728px]:pointer-events-none min-[728px]:invisible min-[1072px]:pointer-events-auto min-[1072px]:visible",
        "flex h-[36px] items-center justify-center gap-2 rounded-[8px] font-normal whitespace-nowrap",
      )}
      onClick={onClick}
      aria-label={accessibleLabel}
      aria-busy={status === "joining" || status === "preparing"}
    >
      {isReadOnly ? <Eye className="h-3 w-3" /> : <Users className="h-3 w-3" />}
      {label}
    </Button>
  );
}
