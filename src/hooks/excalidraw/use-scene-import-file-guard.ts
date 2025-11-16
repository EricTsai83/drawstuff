import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  IMAGE_MIME_TYPES,
  MIME_TYPES,
  SCENE_FILE_IMPORT_MAX_BYTES,
} from "@/config/app-constants";
import { nFormatter } from "@/lib/utils";

const MEDIA_MIME_PREFIXES = ["image/", "video/", "audio/"] as const;
const MEDIA_FILE_EXTENSIONS = new Set<string>([
  "excalidraw",
  ...Object.keys(IMAGE_MIME_TYPES),
  "jpeg",
  "heic",
  "heif",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mp3",
  "wav",
  "flac",
  "aac",
]);

export type SceneImportFileGuardOptions = {
  readonly maxBytes?: number;
};

export function useSceneImportFileGuard(
  options?: SceneImportFileGuardOptions,
): void {
  const maxBytes = options?.maxBytes ?? SCENE_FILE_IMPORT_MAX_BYTES;

  const shouldValidateFile = useCallback((file: File): boolean => {
    const fileType = file.type?.toLowerCase() ?? "";
    if (fileType === MIME_TYPES.excalidraw) {
      return true;
    }
    if (MEDIA_MIME_PREFIXES.some((prefix) => fileType.startsWith(prefix))) {
      return true;
    }

    const fileName = file.name?.toLowerCase() ?? "";
    if (fileName.endsWith(".excalidraw")) {
      return true;
    }
    const ext = fileName.split(".").pop();
    if (!ext) return false;
    return MEDIA_FILE_EXTENSIONS.has(ext);
  }, []);

  const guardFiles = useCallback(
    (fileList: FileList | null): boolean => {
      if (!fileList) return false;

      const files = Array.from(fileList);
      const oversizedFile = files.find((file) =>
        shouldValidateFile(file) ? file.size > maxBytes : false,
      );

      if (!oversizedFile) {
        return false;
      }

      toast.error(
        `匯入失敗：${oversizedFile.name} (${nFormatter(oversizedFile.size, 2)}) 超過上限 ${nFormatter(maxBytes, 2)}`,
      );
      return true;
    },
    [maxBytes, shouldValidateFile],
  );

  useEffect(() => {
    function handleDrop(event: DragEvent): void {
      const shouldBlock = guardFiles(event.dataTransfer?.files ?? null);
      if (!shouldBlock) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer?.clearData();
    }

    function handleFileInputChange(event: Event): void {
      const input = event.target as HTMLInputElement | null;
      if (!input || input.type !== "file") return;
      const shouldBlock = guardFiles(input.files);
      if (!shouldBlock) return;
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
    }

    window.addEventListener("drop", handleDrop, true);
    document.addEventListener("change", handleFileInputChange, true);

    return () => {
      window.removeEventListener("drop", handleDrop, true);
      document.removeEventListener("change", handleFileInputChange, true);
    };
  }, [guardFiles]);
}
