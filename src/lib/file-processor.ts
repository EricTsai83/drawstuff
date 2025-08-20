import type {
  FileId,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import { compressData } from "./encode";
import { isInitializedImageElement } from "@/lib/excalidraw";

// 文件處理選項類型
export type FileProcessingOptions = {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
  encryptionKey?: string | null;
};

// 處理後的文件類型
export type ProcessedFile = {
  id: FileId;
  buffer: Uint8Array;
};

/**
 * 從場景元素中提取圖片文件
 * @param elements 場景元素
 * @param files 二進制文件映射
 * @returns 圖片文件映射
 */
export function extractImageFiles(
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles,
): Map<FileId, BinaryFileData> {
  const imageFilesMap = new Map<FileId, BinaryFileData>();

  for (const element of elements) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      // Record 類型的屬性訪問總是返回 T | undefined，即
      // 使我們在邏輯上已經確保了該屬性存在。最簡潔的解決方案就是使用非空斷言操作符 "!"
      imageFilesMap.set(element.fileId, files[element.fileId]!);
    }
  }

  return imageFilesMap;
}

/**
 * 處理多個文件用於上傳
 * @param options 文件處理選項
 * @returns 處理後的文件列表
 */
export async function processFilesForUpload({
  files,
  maxBytes,
  encryptionKey,
}: FileProcessingOptions): Promise<ProcessedFile[]> {
  const processedFiles: ProcessedFile[] = [];

  for (const [id, fileData] of files) {
    const processedFile = await processSingleFile({
      id,
      fileData,
      maxBytes,
      encryptionKey,
    });

    processedFiles.push(processedFile);
  }

  return processedFiles;
}

/**
 * 處理單個文件
 * @param options 單個文件處理選項
 * @returns 處理後的文件
 */
async function processSingleFile({
  id,
  fileData,
  maxBytes,
  encryptionKey,
}: {
  id: FileId;
  fileData: BinaryFileData;
  maxBytes: number;
  encryptionKey?: string | null;
}): Promise<ProcessedFile> {
  const buffer = new TextEncoder().encode(fileData.dataURL);

  // 檢查文件大小
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `File too big: ${Math.trunc(maxBytes / 1024 / 1024)}MB limit exceeded`,
    );
  }

  const metadata: BinaryFileMetadata = {
    id,
    mimeType: fileData.mimeType,
    created: Date.now(),
    lastRetrieved: Date.now(),
  };

  const encodedFile = await compressData<BinaryFileMetadata>(buffer, {
    encryptionKey,
    metadata,
  });

  return {
    id,
    buffer: encodedFile,
  };
}

/**
 * 驗證文件大小
 * @param fileSize 文件大小（字節）
 * @param maxBytes 最大允許大小（字節）
 * @returns 是否有效
 */
export function validateFileSize(fileSize: number, maxBytes: number): boolean {
  return fileSize <= maxBytes;
}

/**
 * 獲取文件大小的可讀格式
 * @param bytes 字節數
 * @returns 可讀的文件大小字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
