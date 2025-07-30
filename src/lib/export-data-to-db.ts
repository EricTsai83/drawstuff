import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
  ElementOrToolType,
} from "@excalidraw/excalidraw/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";

export async function exportToBackend(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) {
  const encryptionKey = await generateEncryptionKey("string");
  const payload = await compressData(
    new TextEncoder().encode(serializeAsJSON(elements, appState, files)),
    { encryptionKey },
  );

  try {
    const filesMap = new Map<FileId, BinaryFileData>();
    for (const element of elements) {
      if (isInitializedImageElement(element) && files[element.fileId]) {
        // @ts-expect-error - fileId is not typed
        filesMap.set(element.fileId, files[element.fileId]);
      }
    }

    const filesToUpload = await encodeFilesForUpload({
      files: filesMap,
      encryptionKey,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });

    // const response = await fetch("這裡要放入儲存檔案的 API endpoint", {
    //   method: "POST",
    //   body: payload.buffer,
    // });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    // const response = await response.json();

    // TODO: 測試用之後要刪除
    const response = {
      id: "123",
      status: "success",
      error_class: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (response.id) {
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      // https://developer.mozilla.org/en-US/docs/Web/API/URL/hash
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      url.hash = `json=${response.id},${encryptionKey}`;
      const urlString = url.toString();

      await saveFilesToUploadthing({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        prefix: `/files/shareLinks/${response.id}`,
        files: filesToUpload,
      });

      return { url: urlString, errorMessage: null };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    } else if (response.error_class === "RequestTooLargeError") {
      return {
        url: null,
        // errorMessage: t("alerts.couldNotCreateShareableLinkTooBig"),
        errorMessage: "Could not create shareable link: Too big",
      };
    }

    return {
      url: null,
      // errorMessage: t("alerts.couldNotCreateShareableLink")
      errorMessage: "Could not create shareable link",
    };
  } catch (error: unknown) {
    console.error(error);

    return {
      url: null,
      // errorMessage: t("alerts.couldNotCreateShareableLink")
      errorMessage: "Could not create shareable link",
    };
  }
}

const filterOutDeletedFiles = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
) => {
  const nextFiles: BinaryFiles = {};
  for (const element of elements) {
    if (
      !element.isDeleted &&
      "fileId" in element &&
      element.fileId &&
      files[element.fileId]
    ) {
      // @ts-expect-error - fileId is not typed
      nextFiles[element.fileId] = files[element.fileId];
    }
  }
  return nextFiles;
};
export function serializeAsJSON(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): string {
  const data = {
    elements: clearElementsForDatabase(elements),
    appState,
    files: filterOutDeletedFiles(elements, files),
  };

  return JSON.stringify(data, null, 2);
}

const clearElementsForDatabase = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] =>
  getNonDeletedElements(elements).map((element) =>
    isLinearElementType(element.type)
      ? { ...element, lastCommittedPoint: null }
      : element,
  );

const getNonDeletedElements = <T extends ExcalidrawElement>(
  elements: readonly T[],
) =>
  elements.filter((element) => !element.isDeleted) as readonly NonDeleted<T>[];

const isLinearElementType = (elementType: ElementOrToolType): boolean => {
  return (
    elementType === "arrow" || elementType === "line" // || elementType === "freedraw"
  );
};

export const isInitializedImageElement = (
  element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement => {
  return !!element && element.type === "image" && !!element.fileId;
};

export const encodeFilesForUpload = async ({
  files,
  maxBytes,
  encryptionKey,
}: {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
  encryptionKey: string;
}) => {
  const processedFiles: {
    id: FileId;
    buffer: Uint8Array;
  }[] = [];

  for (const [id, fileData] of files) {
    const buffer = new TextEncoder().encode(fileData.dataURL);

    const encodedFile = await compressData<BinaryFileMetadata>(buffer, {
      encryptionKey,
      metadata: {
        id,
        mimeType: fileData.mimeType,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    });

    if (buffer.byteLength > maxBytes) {
      throw new Error(`File too big: ${Math.trunc(maxBytes / 1024 / 1024)}MB`);
    }

    processedFiles.push({
      id,
      buffer: encodedFile,
    });
  }

  return processedFiles;
};

async function saveFilesToUploadthing({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: string; buffer: Uint8Array }[];
}) {
  console.log("save files to uploadthing", prefix, files);
}
