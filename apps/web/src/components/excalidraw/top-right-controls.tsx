"use client";

import type { CanvasProductActions } from "./canvas-product-actions";
import { useEffect } from "react";
import { CanvasShortcutMenu } from "./canvas-shortcut-menu";

type TopRightControlsProps = {
  actions: CanvasProductActions;
  isMobile: boolean;
  onLibraryActivate: () => void;
  onSlotChange?: (isMobile: boolean) => void;
};

export function TopRightControls({
  actions,
  isMobile,
  onLibraryActivate,
  onSlotChange,
}: TopRightControlsProps) {
  useEffect(() => {
    onSlotChange?.(isMobile);
  }, [isMobile, onSlotChange]);

  if (isMobile) {
    return null;
  }

  return (
    <div data-testid="canvas-product-actions">
      <CanvasShortcutMenu
        actions={actions}
        onLibraryActivate={onLibraryActivate}
      />
    </div>
  );
}
