import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import { generateEncryptionKey } from "./encryption";
import { compressData } from "./encode";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import {
  isInitializedImageElement,
  clearElementsForDatabase,
} from "@/lib/excalidraw";

export async function exportSceneToBackend(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) {
  const encryptionKey = await generateEncryptionKey("string");
  const payload = await compressData(
    new TextEncoder().encode(serializeAsJSON(elements, appState)),
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

    const response = await fetch("/api/trpc/scene.saveScene", {
      method: "POST",
      body: payload.buffer,
    });
    const json = (await response.json()) as {
      id: string;
      error_class: string | null;
    };

    if (json.id) {
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      // https://developer.mozilla.org/en-US/docs/Web/API/URL/hash
      url.hash = `json=${json.id},${encryptionKey}`;
      const urlString = url.toString();

      await saveFilesToUploadthing({
        prefix: `/files/shareLinks/${json.id}`,
        files: filesToUpload,
      });

      return { url: urlString, errorMessage: null };
    } else if (json.error_class === "RequestTooLargeError") {
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

function serializeAsJSON(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
): string {
  const data = {
    elements: clearElementsForDatabase(elements),
    appState,
  };

  return JSON.stringify(data, null, 2);
}

async function encodeFilesForUpload({
  files,
  maxBytes,
  encryptionKey,
}: {
  files: Map<FileId, BinaryFileData>;
  maxBytes: number;
  encryptionKey: string;
}) {
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
}

async function saveFilesToUploadthing({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: string; buffer: Uint8Array }[];
}) {
  console.log("save files to uploadthing", prefix, files);
}
