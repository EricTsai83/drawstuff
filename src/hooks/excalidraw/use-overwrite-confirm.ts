import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { toast } from "sonner";
import { setOverwriteConfirmHandler } from "@/lib/initialize-scene";
import {
  getCurrentSceneSnapshot,
  saveSceneJsonToDisk,
  exportSceneToPngBlob,
} from "@/lib/excalidraw";
import { triggerBlobDownload } from "@/lib/download";
import { useCloudUpload } from "@/hooks/use-cloud-upload";

export type UseOverwriteConfirmArgs = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
};

export type UseOverwriteConfirmResult = {
  open: boolean;
  isReady: boolean;
  handleOpenChange: (nextOpen: boolean) => void;
  handleConfirm: () => void;
  handleClose: () => void;
  handleExportImage: () => Promise<void>;
  handleSaveToDisk: () => void;
  handleUploadToCloud: () => Promise<void>;
};

export function useOverwriteConfirm(
  props: UseOverwriteConfirmArgs,
): UseOverwriteConfirmResult {
  const { excalidrawAPI } = props;
  const cloudUpload = useCloudUpload(excalidrawAPI);

  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const resolvedFlagRef = useRef(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setOverwriteConfirmHandler(async () => {
      return await new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        resolvedFlagRef.current = false;
        setIsOpen(true);
      });
    });
    setIsReady(true);
    return () => setOverwriteConfirmHandler(null);
  }, []);

  const handleClose = useCallback(function handleClose(): void {
    if (!resolvedFlagRef.current) {
      resolveRef.current?.(false);
      resolvedFlagRef.current = true;
    }
    setIsOpen(false);
    resolveRef.current = null;
  }, []);

  const handleConfirm = useCallback(() => {
    if (!resolvedFlagRef.current) {
      resolveRef.current?.(true);
      resolvedFlagRef.current = true;
    }
    setIsOpen(false);
    resolveRef.current = null;
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleClose();
      } else {
        setIsOpen(true);
      }
    },
    [handleClose],
  );

  const handleExportImage = useCallback(async () => {
    const scene = getCurrentSceneSnapshot(excalidrawAPI);
    if (!scene) return;
    try {
      const blob = await exportSceneToPngBlob(
        scene.elements,
        scene.appState,
        scene.files,
      );
      const fileName = `${(scene.appState.name as string | undefined) ?? "scene"}.png`;
      triggerBlobDownload(fileName, blob);
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error("Export image failed:", errorObj);
      toast.error("Failed to export image. Please try again.");
    } finally {
      handleClose();
    }
  }, [excalidrawAPI, handleClose]);

  const handleSaveToDisk = useCallback(() => {
    const scene = getCurrentSceneSnapshot(excalidrawAPI);
    if (!scene) return;
    try {
      saveSceneJsonToDisk(
        scene.elements as readonly NonDeletedExcalidrawElement[],
        scene.appState,
        scene.files,
      );
      toast.success("File saved to disk successfully!");
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error("Save failed:", errorObj);
      toast.error("Failed to save file. Please try again.");
    } finally {
      handleClose();
    }
  }, [excalidrawAPI, handleClose]);

  const handleUploadToCloud = useCallback(async () => {
    try {
      const ok = await cloudUpload.uploadSceneToCloud();
      if (ok) {
        toast.success("Successfully uploaded to cloud!");
      } else {
        toast.error("Failed to upload to cloud. Please try again.");
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error("Cloud upload error:", errorObj);
      toast.error("Failed to upload to cloud. Please try again.");
    } finally {
      handleClose();
    }
  }, [cloudUpload, handleClose]);

  return {
    open: isOpen,
    isReady,
    handleOpenChange,
    handleConfirm,
    handleClose,
    handleExportImage,
    handleSaveToDisk,
    handleUploadToCloud,
  };
}
