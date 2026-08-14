"use client";

import type { ComponentProps } from "react";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";

import { CollaborationRoomDialog } from "@/components/excalidraw/collaboration-room-dialog";
import { OverwriteConfirmDialog } from "@/components/excalidraw/overwrite-confirm-dialog";
import { SceneChangeConfirmDialog } from "@/components/excalidraw/scene-change-confirm-dialog";
import { SceneCloudUploadDialog } from "@/components/excalidraw/scene-cloud-upload-dialog";
import { SceneRemoteConflictDialog } from "@/components/excalidraw/scene-remote-conflict-dialog";

/**
 * The editor's dialog layer: every dialog the canvas can open, grouped so the
 * editor component reads as wiring rather than as a wall of JSX. Pure
 * passthrough — each dialog keeps its own props, grouped by dialog.
 */
export function EditorDialogs(props: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  sceneChange: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChoose: (choice: "save" | "switch" | "cancel") => void;
    isLoading: boolean;
  };
  overwrite: {
    clearCurrentSceneId: () => void;
    onSceneNotFoundError: () => void;
  };
  remoteConflict: ComponentProps<typeof SceneRemoteConflictDialog>;
  collaboration: ComponentProps<typeof CollaborationRoomDialog>;
  cloudUpload: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: ComponentProps<typeof SceneCloudUploadDialog>["onConfirm"];
  };
}) {
  return (
    <>
      <SceneChangeConfirmDialog
        open={props.sceneChange.open}
        onOpenChange={props.sceneChange.onOpenChange}
        onChoose={props.sceneChange.onChoose}
        isLoading={props.sceneChange.isLoading}
      />
      <OverwriteConfirmDialog
        excalidrawAPI={props.excalidrawAPI}
        clearCurrentSceneId={props.overwrite.clearCurrentSceneId}
        onSceneNotFoundError={props.overwrite.onSceneNotFoundError}
      />
      <SceneRemoteConflictDialog {...props.remoteConflict} />
      <CollaborationRoomDialog {...props.collaboration} />
      <SceneCloudUploadDialog
        open={props.cloudUpload.open}
        onOpenChange={props.cloudUpload.onOpenChange}
        excalidrawAPI={props.excalidrawAPI}
        onConfirm={props.cloudUpload.onConfirm}
      />
    </>
  );
}
