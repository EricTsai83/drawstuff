"use client";

import type { CanvasProductActions } from "./canvas-product-actions";
import { useEffect, type ReactNode } from "react";
import { CanvasShortcutMenu } from "./canvas-shortcut-menu";

type TopRightControlsProps = {
  actions: CanvasProductActions;
  isMobile: boolean;
  onLibraryActivate: () => void;
  onSlotChange?: (isMobile: boolean) => void;
  storageStatus?: ReactNode;
};

export function TopRightControls({
  actions,
  isMobile,
  onLibraryActivate,
  onSlotChange,
  storageStatus,
}: TopRightControlsProps) {
  useEffect(() => {
    onSlotChange?.(isMobile);
  }, [isMobile, onSlotChange]);

  // The mobile toolbar row has no room to spare; the room badge is placed by
  // MobileRoomBadge and quick actions live in the main menu.
  if (isMobile) {
    return null;
  }

  return (
    <div
      className="flex items-center gap-2"
      data-testid="canvas-product-actions"
    >
      {storageStatus}
      <CanvasShortcutMenu
        actions={actions}
        onLibraryActivate={onLibraryActivate}
      />
    </div>
  );
}
