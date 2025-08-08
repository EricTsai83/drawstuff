export function createJsonBlob(data: unknown): Blob {
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

export function triggerBlobDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
