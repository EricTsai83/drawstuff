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
    label?: string;
    statusLabel?: string;
    status: UploadStatus;
    /** False when another surface already shows this status (a room's badge). */
    showStatusBadge?: boolean;
    onActivate: () => void;
  } | null;
  /** Null in a room: a snapshot link there is not an invitation. */
  share: {
    status: ExportStatus;
    onActivate: () => void;
  } | null;
};
