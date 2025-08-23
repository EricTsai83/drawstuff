"use client";
import {
  CloudUploadButton,
  type UploadStatus,
} from "@/components/excalidraw/cloud-upload-button";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { ShareSceneButton } from "./share-scene-button";

type TopRightControlsProps = {
  linkExportStatus: ExportStatus;
  cloudUploadStatus: UploadStatus;
  onUploadClick: () => void;
  onUploadSuccess: () => void;
  onShareLinkClick: () => void;
};

export function TopRightControls({
  linkExportStatus,
  cloudUploadStatus,
  onUploadClick,
  onUploadSuccess,
  onShareLinkClick,
}: TopRightControlsProps) {
  return (
    <>
      <CloudUploadButton
        status={cloudUploadStatus}
        errorMessage="網路連線失敗"
        onClick={onUploadClick}
        onSuccess={onUploadSuccess}
      />
      <ShareSceneButton
        exportStatus={linkExportStatus}
        onClick={onShareLinkClick}
      />
    </>
  );
}
