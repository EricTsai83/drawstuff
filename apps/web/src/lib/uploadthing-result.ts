export type UploadedFileRef = {
  key: string;
  url: string;
};

/**
 * Reads the single uploaded file out of a `startUpload` result. The upload
 * routes echo `fileKey`/`fileUrl` from `onUploadComplete` as `serverData`;
 * the client-side `key`/`ufsUrl` are the fallback for routes that return
 * nothing.
 */
export function readSingleUploadedFile(
  uploadResult: unknown,
  label: string,
): UploadedFileRef {
  if (!Array.isArray(uploadResult) || uploadResult.length !== 1) {
    throw new Error(`${label} upload did not return exactly one file`);
  }
  const item = uploadResult[0] as {
    key?: unknown;
    ufsUrl?: unknown;
    serverData?: { fileKey?: unknown; fileUrl?: unknown } | null;
  };
  const key = pickString(item.serverData?.fileKey) ?? pickString(item.key);
  const url = pickString(item.serverData?.fileUrl) ?? pickString(item.ufsUrl);
  if (!key) {
    throw new Error(`${label} upload did not return a file key`);
  }
  if (!url) {
    throw new Error(`${label} upload did not return a file URL`);
  }
  return { key, url };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
