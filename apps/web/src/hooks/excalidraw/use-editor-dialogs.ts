"use client";

import { useCallback, useState } from "react";

/**
 * The editor's own dialog open/close flags, in one place.
 *
 * Only the dialogs whose state was raw `useState` in the editor live here; the
 * prompts with real logic behind them (scene-change confirm, workspace-create
 * confirm) keep their dedicated hooks.
 */
export function useEditorDialogs() {
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isCollaborationDialogOpen, setIsCollaborationDialogOpen] =
    useState(false);
  const [isCloudUploadDialogOpen, setIsCloudUploadDialogOpen] = useState(false);

  const openCollaborationDialog = useCallback(() => {
    setIsCollaborationDialogOpen(true);
  }, []);
  const openCloudUploadDialog = useCallback(() => {
    setIsCloudUploadDialogOpen(true);
  }, []);

  return {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isCollaborationDialogOpen,
    setIsCollaborationDialogOpen,
    openCollaborationDialog,
    isCloudUploadDialogOpen,
    setIsCloudUploadDialogOpen,
    openCloudUploadDialog,
  };
}
