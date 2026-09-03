"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import type { UploadStatus } from "@/components/excalidraw/cloud-upload-presentation";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { ExportStatus } from "@/hooks/use-scene-export";

/** How long a settled status stays on the buttons before returning to idle. */
const STATUS_RESET_DELAY_MS = 1_500;

/**
 * The editor's two settle-and-reset status effects, deduplicated: a successful
 * upload/export shows its state briefly and returns to idle; a failed one
 * additionally announces the error as a toast, since the button state alone
 * does not say what went wrong.
 */
export function useEditorStatusToasts(options: {
  uploadStatus: UploadStatus;
  resetUploadStatus: () => void;
  exportStatus: ExportStatus;
  /** Shown for an export error when the export produced a message. */
  exportErrorMessage: string | null | undefined;
  resetExportStatus: () => void;
}): void {
  const {
    uploadStatus,
    resetUploadStatus,
    exportStatus,
    exportErrorMessage,
    resetExportStatus,
  } = options;
  const { t } = useAppI18n();

  useEffect(() => {
    if (uploadStatus === "success") {
      const timer = setTimeout(() => {
        resetUploadStatus();
      }, STATUS_RESET_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (uploadStatus === "error") {
      toast.error(t("toast.cloud.uploadFailed"));
      const timer = setTimeout(() => {
        resetUploadStatus();
      }, STATUS_RESET_DELAY_MS);
      return () => clearTimeout(timer);
    }
    return;
  }, [uploadStatus, resetUploadStatus, t]);

  useEffect(() => {
    if (exportStatus === "success") {
      const timer = setTimeout(() => {
        resetExportStatus();
      }, STATUS_RESET_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (exportStatus === "error") {
      const message =
        typeof exportErrorMessage === "string"
          ? exportErrorMessage
          : t("errors.failedToExportScene");
      toast.error(message);
      const timer = setTimeout(() => {
        resetExportStatus();
      }, STATUS_RESET_DELAY_MS);
      return () => clearTimeout(timer);
    }
    return;
  }, [exportStatus, exportErrorMessage, resetExportStatus, t]);
}
