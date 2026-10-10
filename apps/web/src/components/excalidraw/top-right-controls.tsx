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
  /** The room badge for the mobile toolbar row; absent outside a room. */
  mobileStorageStatus?: ReactNode;
};

export function TopRightControls({
  actions,
  isMobile,
  onLibraryActivate,
  onSlotChange,
  storageStatus,
  mobileStorageStatus,
}: TopRightControlsProps) {
  useEffect(() => {
    onSlotChange?.(isMobile);
  }, [isMobile, onSlotChange]);

  // The mobile toolbar row has room for the room badge (icon only) and
  // nothing else; quick actions live in the main menu there.
  if (isMobile) {
    return mobileStorageStatus ?? null;
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
