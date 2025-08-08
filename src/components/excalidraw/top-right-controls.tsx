"use client";
import {
  CloudUploadStatus,
  type UploadStatus,
} from "@/components/excalidraw/cloud-upload-status";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { ShareSceneButton } from "./share-scene-button";

type TopRightControlsProps = {
  exportStatus: ExportStatus;
  uploadStatus: UploadStatus;
  onClick: () => void;
  onSuccess: () => void;
  onShareClick: () => void;
};

export function TopRightControls({
  exportStatus,
  uploadStatus,
  onClick,
  onSuccess,
  onShareClick,
}: TopRightControlsProps) {
  return (
    <>
      <CloudUploadStatus
        status={uploadStatus}
        errorMessage="網路連線失敗"
        onClick={onClick}
        onSuccess={onSuccess}
      />

      <ShareSceneButton exportStatus={exportStatus} onClick={onShareClick} />
    </>
  );
}
