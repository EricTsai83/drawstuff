import type { ExcalidrawLibraryItems } from "@drawstuff/excalidraw-adapter/types";

import {
  base64ToArrayBuffer,
  compressData,
  decompressData,
} from "@/lib/encode";

export const PERSONAL_LIBRARY_FORMAT_VERSION = 1;
export const PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES = 3 * 1024 * 1024;
export const PERSONAL_LIBRARY_MAX_BASE64_LENGTH = 4 * 1024 * 1024;
export const PERSONAL_LIBRARY_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;
export const PERSONAL_LIBRARY_NO_REVISION = 0;

const STRICT_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PersonalLibraryEnvelope = {
  libraryItems: ExcalidrawLibraryItems;
};

export type StoredPersonalLibrary = {
  revision: number;
  formatVersion: number;
  compressedDataBase64: string;
  byteLength: number;
  checksum: string;
};

export class PersonalLibraryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalLibraryValidationError";
  }
}

export function isStrictBase64(value: string): boolean {
  return (
    value.length > 0 && value.length % 4 === 0 && STRICT_BASE64.test(value)
  );
}

export function decodePersonalLibraryBase64(value: string): Uint8Array {
  if (
    value.length > PERSONAL_LIBRARY_MAX_BASE64_LENGTH ||
    !isStrictBase64(value)
  ) {
    throw new PersonalLibraryValidationError(
      "Invalid personal Library base64 payload.",
    );
  }
  const bytes = new Uint8Array(base64ToArrayBuffer(value));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES
  ) {
    throw new PersonalLibraryValidationError(
      "Personal Library compressed payload is too large.",
    );
  }
  return bytes;
}

export function encodePersonalLibraryBase64(bytes: Uint8Array): string {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES
  ) {
    throw new PersonalLibraryValidationError(
      "Personal Library compressed payload is too large.",
    );
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export async function personalLibraryChecksum(
  bytes: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePersonalLibraryEnvelope(
  value: unknown,
): PersonalLibraryEnvelope {
  if (!isRecord(value) || !Array.isArray(value.libraryItems)) {
    throw new PersonalLibraryValidationError(
      "Invalid personal Library envelope.",
    );
  }

  for (const item of value.libraryItems) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      (item.status !== "published" && item.status !== "unpublished") ||
      typeof item.created !== "number" ||
      !Number.isFinite(item.created) ||
      !Array.isArray(item.elements) ||
      (item.name !== undefined && typeof item.name !== "string") ||
      (item.error !== undefined && typeof item.error !== "string")
    ) {
      throw new PersonalLibraryValidationError(
        "Invalid personal Library item.",
      );
    }
    for (const element of item.elements) {
      if (
        !isRecord(element) ||
        typeof element.id !== "string" ||
        typeof element.type !== "string"
      ) {
        throw new PersonalLibraryValidationError(
          "Invalid personal Library element.",
        );
      }
    }
  }

  return { libraryItems: value.libraryItems as ExcalidrawLibraryItems };
}

export async function compressPersonalLibrary(
  libraryItems: ExcalidrawLibraryItems,
): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(JSON.stringify({ libraryItems }));
  if (raw.byteLength > PERSONAL_LIBRARY_MAX_DECOMPRESSED_BYTES) {
    throw new PersonalLibraryValidationError(
      "Personal Library content is too large.",
    );
  }
  const compressed = await compressData(raw, {});
  if (compressed.byteLength > PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES) {
    throw new PersonalLibraryValidationError(
      "Personal Library compressed payload is too large.",
    );
  }
  return compressed;
}

export async function decompressPersonalLibrary(
  compressed: Uint8Array,
): Promise<PersonalLibraryEnvelope> {
  if (
    compressed.byteLength === 0 ||
    compressed.byteLength > PERSONAL_LIBRARY_MAX_COMPRESSED_BYTES
  ) {
    throw new PersonalLibraryValidationError(
      "Personal Library compressed payload is too large.",
    );
  }
  const { data } = await decompressData<Record<string, never>>(compressed, {
    decryptionKey: "",
    maxDecompressedBytes: PERSONAL_LIBRARY_MAX_DECOMPRESSED_BYTES,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data)) as unknown;
  } catch {
    throw new PersonalLibraryValidationError(
      "Invalid personal Library JSON payload.",
    );
  }
  return parsePersonalLibraryEnvelope(parsed);
}

export async function decodeStoredPersonalLibrary(
  stored: StoredPersonalLibrary,
): Promise<PersonalLibraryEnvelope> {
  if (stored.formatVersion !== PERSONAL_LIBRARY_FORMAT_VERSION) {
    throw new PersonalLibraryValidationError(
      "Unsupported personal Library format version.",
    );
  }
  const compressed = decodePersonalLibraryBase64(stored.compressedDataBase64);
  if (compressed.byteLength !== stored.byteLength) {
    throw new PersonalLibraryValidationError(
      "Personal Library byte length does not match.",
    );
  }
  if ((await personalLibraryChecksum(compressed)) !== stored.checksum) {
    throw new PersonalLibraryValidationError(
      "Personal Library checksum does not match.",
    );
  }
  return decompressPersonalLibrary(compressed);
}

/** The catalog must never receive a scene id, room id, or fragment key. */
export function getCanonicalLibraryReturnUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}
