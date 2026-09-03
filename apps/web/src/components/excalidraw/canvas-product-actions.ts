import type { UploadStatus } from "./cloud-upload-presentation";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import type { ExportStatus } from "@/hooks/use-scene-export";

export type CanvasProductActions = {
  collaboration: {
    status: CollaborationRoomStatus;
    isReadOnly: boolean;
    onActivate: () => void;
  };
  cloudSave: {
    status: UploadStatus;
    onActivate: () => void;
  } | null;
  share: {
    status: ExportStatus;
    onActivate: () => void;
  };
};
