"use client";

import {
  CloudUploadButton,
  type UploadStatus,
} from "@/components/excalidraw/cloud-upload-button";
import { CollaborationButton } from "@/components/excalidraw/collaboration-button";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { ExportStatus } from "@/hooks/use-scene-export";
import { ShareSceneButton } from "./share-scene-button";

type TopRightControlsProps = {
  linkExportStatus: ExportStatus;
  cloudUploadStatus: UploadStatus;
  onCloudUploadClick: () => void;
  onShareLinkClick: () => void;
  collaborationStatus: CollaborationRoomStatus;
  isCollaborationReadOnly: boolean;
  onCollaborationClick: () => void;
};

export function TopRightControls({
  linkExportStatus,
  cloudUploadStatus,
  onCloudUploadClick,
  onShareLinkClick,
  collaborationStatus,
  isCollaborationReadOnly,
  onCollaborationClick,
}: TopRightControlsProps) {
  const { t } = useAppI18n();

  return (
    <>
      <CloudUploadButton
        status={cloudUploadStatus}
        errorMessage={t("collaboration.error.network")}
        onClick={onCloudUploadClick}
      />
      <CollaborationButton
        status={collaborationStatus}
        isReadOnly={isCollaborationReadOnly}
        onClick={onCollaborationClick}
      />
      <ShareSceneButton
        exportStatus={linkExportStatus}
        onClick={onShareLinkClick}
      />
    </>
  );
}
