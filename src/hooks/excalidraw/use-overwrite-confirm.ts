import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { exportToBlob } from "@excalidraw/excalidraw";
import { toast } from "sonner";
import {
  type OverwriteConfirmRequest,
  setOverwriteConfirmHandler,
} from "@/lib/initialize-scene";
import { getCurrentSceneSnapshot } from "@/lib/excalidraw";
import { createJsonBlob, triggerBlobDownload } from "@/lib/download";
import type { ExcalidrawSceneData } from "@/lib/excalidraw";
import { useCloudUpload } from "@/hooks/use-cloud-upload";

export type UseOverwriteConfirmArgs = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
};

export type UseOverwriteConfirmResult = {
  request: OverwriteConfirmRequest | null;
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
  const cloudUpload = useCloudUpload();

  const [isOpen, setIsOpen] = useState(false);
  const [request, setRequest] = useState<OverwriteConfirmRequest | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const resolvedFlagRef = useRef(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(function installOverwriteConfirmHandler() {
    setOverwriteConfirmHandler(async (incomingRequest) => {
      return await new Promise<boolean>((resolve) => {
        setRequest(incomingRequest);
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
    setRequest(null);
  }, []);

  const handleConfirm = useCallback(function handleConfirm(): void {
    if (!resolvedFlagRef.current) {
      resolveRef.current?.(true);
      resolvedFlagRef.current = true;
    }
    setIsOpen(false);
    resolveRef.current = null;
    setRequest(null);
  }, []);

  const handleOpenChange = useCallback(
    function handleOpenChange(nextOpen: boolean): void {
      if (!nextOpen) {
        handleClose();
      } else {
        setIsOpen(true);
      }
    },
    [handleClose],
  );

  const handleExportImage = useCallback(
    async function handleExportImage(): Promise<void> {
      const scene = getCurrentSceneSnapshot(excalidrawAPI);
      if (!scene) return;
      try {
        const exportToBlobFn = exportToBlob as (args: {
          elements: readonly NonDeletedExcalidrawElement[];
          appState: Partial<AppState>;
          files: BinaryFiles;
          mimeType: "image/png";
          quality: number;
        }) => Promise<Blob>;
        const blob = await exportToBlobFn({
          elements: scene.elements as readonly NonDeletedExcalidrawElement[],
          appState: scene.appState,
          files: scene.files,
          mimeType: "image/png",
          quality: 1,
        });
        const fileName = `${(scene.appState.name as string | undefined) ?? "scene"}.png`;
        triggerBlobDownload(fileName, blob);
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        console.error("Export image failed:", errorObj);
        toast.error("Failed to export image. Please try again.");
      } finally {
        handleClose();
      }
    },
    [excalidrawAPI, handleClose],
  );

  const handleSaveToDisk = useCallback(
    function handleSaveToDisk(): void {
      const scene = getCurrentSceneSnapshot(excalidrawAPI);
      if (!scene) return;
      try {
        const sceneData: ExcalidrawSceneData = {
          type: "excalidraw",
          version: 2,
          source: "https://excalidraw.com",
          elements: scene.elements as readonly NonDeletedExcalidrawElement[],
          appState: scene.appState,
          files: scene.files,
        };
        const blob = createJsonBlob(sceneData);
        triggerBlobDownload(
          `${(scene.appState.name as string | undefined) ?? "scene"}.excalidraw`,
          blob,
        );
        toast.success("File saved to disk successfully!");
      } catch (err: unknown) {
        console.error("Save failed:", err as Error);
        toast.error("Failed to save file. Please try again.");
      } finally {
        handleClose();
      }
    },
    [excalidrawAPI, handleClose],
  );

  const handleUploadToCloud = useCallback(
    async function handleUploadToCloud(): Promise<void> {
      const scene = getCurrentSceneSnapshot(excalidrawAPI);
      if (!scene) return;
      try {
        const ok = await cloudUpload.uploadSceneToCloud(
          scene.elements as readonly NonDeletedExcalidrawElement[],
          scene.appState,
          scene.files,
        );
        if (ok) {
          toast.success("Successfully uploaded to cloud!");
        } else {
          toast.error("Failed to upload to cloud. Please try again.");
        }
      } catch (err: unknown) {
        console.error("Cloud upload error:", err as Error);
        toast.error("Failed to upload to cloud. Please try again.");
      } finally {
        handleClose();
      }
    },
    [excalidrawAPI, cloudUpload, handleClose],
  );

  return {
    request,
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
