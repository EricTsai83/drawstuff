"use client";

import type { ReactNode } from "react";

import { useExcalidrawDevice } from "@drawstuff/excalidraw-adapter/client";
import { cn } from "@/lib/utils";

/**
 * Keeps the room badge reachable in Excalidraw's mobile layout, where the
 * top-right slot is either too cramped (beside the tools) or not rendered at
 * all (view mode). Reads upstream's own layout decision, so it follows resizes
 * in both directions. Must render inside <Excalidraw>.
 */
export function MobileRoomBadge(props: {
  /** Edit mode shows the tools row at the top; sit just below it. */
  belowToolbar: boolean;
  children: ReactNode;
}) {
  const device = useExcalidrawDevice();
  if (!device.editor.isMobile) return null;
  // Left edge: upstream's mobile tools column (library, lock, hand) owns the
  // right edge just below the tools row.
  return (
    <div
      className={cn(
        "fixed left-[calc(var(--app-safe-area-left)+0.75rem)] z-10",
        props.belowToolbar
          ? "top-[calc(var(--app-safe-area-top)+4.25rem)]"
          : "top-[calc(var(--app-safe-area-top)+0.75rem)]",
      )}
    >
      {props.children}
    </div>
  );
}
