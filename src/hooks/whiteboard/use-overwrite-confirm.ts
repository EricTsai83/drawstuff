import { useCallback, useEffect, useRef, useState } from "react";
import type { WhiteboardEngine } from "@drawstuff/whiteboard";
import { toast } from "sonner";
import { setOverwriteConfirmHandler } from "@/lib/initialize-scene";
import { triggerBlobDownload } from "@/lib/download";
import { useCloudUpload } from "@/hooks/use-cloud-upload";

export type UseOverwriteConfirmArgs = {
  engine: WhiteboardEngine | null;
  onSceneNotFoundError?: () => void;
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
  const { engine, onSceneNotFoundError } = props;
  const cloudUpload = useCloudUpload(() => {
    // 當場景找不到時，關閉當前 dialog 並通知上層
    handleClose();
    onSceneNotFoundError?.();
  }, engine);

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
    if (!engine) return;
    try {
      const blob = await engine.exportImage({
        format: "png",
        background: true,
      });
      const fileName = `${engine.getEditorState().name || "scene"}.png`;
      triggerBlobDownload(fileName, blob);
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      console.error("Export image failed:", errorObj);
      toast.error("Failed to export image. Please try again.");
    } finally {
      handleClose();
    }
  }, [engine, handleClose]);

  const handleSaveToDisk = useCallback(() => {
    if (!engine) return;
    const fileName = `${engine.getEditorState().name || "scene"}.drawstuff`;
    const save = async () => {
      try {
        triggerBlobDownload(fileName, await engine.exportDocument());
        toast.success("File saved to disk successfully!");
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        console.error("Save failed:", errorObj);
        toast.error("Failed to save file. Please try again.");
      } finally {
        handleClose();
      }
    };
    void save();
  }, [engine, handleClose]);

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
