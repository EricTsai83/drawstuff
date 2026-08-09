"use client";

import { CloudUploadButton } from "@/components/excalidraw/cloud-upload-button";
import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import { ShareSceneButton } from "./share-scene-button";
import type { CanvasProductActions } from "./canvas-product-actions";
import { useEffect } from "react";

type TopRightControlsProps = {
  actions: CanvasProductActions;
  isMobile: boolean;
  onSlotChange?: (isMobile: boolean) => void;
};

export function TopRightControls({
  actions,
  isMobile,
  onSlotChange,
}: TopRightControlsProps) {
  useEffect(() => {
    onSlotChange?.(isMobile);
  }, [isMobile, onSlotChange]);

  if (isMobile) {
    return null;
  }

  return (
    <div
      className="flex items-center gap-2"
      data-testid="canvas-product-actions"
    >
      {actions.cloudSave && (
        <CloudUploadButton
          status={actions.cloudSave.status}
          onClick={actions.cloudSave.onActivate}
        />
      )}
      <CollaborationButton
        status={actions.collaboration.status}
        isReadOnly={actions.collaboration.isReadOnly}
        onClick={actions.collaboration.onActivate}
        presentation="responsive"
      />
      <ShareSceneButton
        exportStatus={actions.share.status}
        onClick={actions.share.onActivate}
        presentation="responsive"
      />
    </div>
  );
}
