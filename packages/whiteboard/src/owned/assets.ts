import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  WhiteboardElement,
  WhiteboardViewport,
} from "../contracts";
import { createOwnedElementId } from "./drawing";
import { createOwnedElementRuntimeFields } from "./element-version";

export const OWNED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OWNED_IMAGE_MAX_DIMENSION = 8192;
export const OWNED_IMAGE_MAX_PIXELS = 40_000_000;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const RENDERABLE_IMAGE_MIME_TYPES = new Set([
  ...SUPPORTED_IMAGE_MIME_TYPES,
  "image/bmp",
  "image/jfif",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/x-icon",
]);

export type WhiteboardAssetErrorCode =
  | "CORRUPT_IMAGE"
  | "EMPTY_IMAGE"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_IMAGE_TYPE";

export class WhiteboardAssetError extends Error {
  public constructor(
    public readonly code: WhiteboardAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WhiteboardAssetError";
  }
}

export interface ImportedWhiteboardImage {
  readonly asset: WhiteboardAsset;
  readonly deduplicated: boolean;
  readonly height: number;
  readonly width: number;
}

export async function importWhiteboardImage(
  blob: Blob,
  assets: Readonly<Record<string, WhiteboardAsset>>,
  options?: {
    readonly maxBytes?: number;
    readonly now?: () => number;
  },
): Promise<ImportedWhiteboardImage> {
  const maxBytes = options?.maxBytes ?? OWNED_IMAGE_MAX_BYTES;
  if (blob.size === 0) {
    throw new WhiteboardAssetError("EMPTY_IMAGE", "The image file is empty");
  }
  if (blob.size > maxBytes) {
    throw new WhiteboardAssetError(
      "IMAGE_TOO_LARGE",
      `The image exceeds the ${maxBytes} byte limit`,
    );
  }

  const mimeType = normalizeImageMimeType(blob.type);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new WhiteboardAssetError(
      "UNSUPPORTED_IMAGE_TYPE",
      `Unsupported image type: ${blob.type || "unknown"}`,
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dimensions = readImageDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new WhiteboardAssetError(
      "CORRUPT_IMAGE",
      "The image header is invalid or unsupported",
    );
  }
  if (
    dimensions.width > OWNED_IMAGE_MAX_DIMENSION ||
    dimensions.height > OWNED_IMAGE_MAX_DIMENSION ||
    dimensions.width * dimensions.height > OWNED_IMAGE_MAX_PIXELS
  ) {
    throw new WhiteboardAssetError(
      "IMAGE_TOO_LARGE",
      `The decoded image exceeds ${OWNED_IMAGE_MAX_DIMENSION}px or ${OWNED_IMAGE_MAX_PIXELS} pixels`,
    );
  }

  const dataURL = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  const existing = Object.values(assets).find(
    (asset) =>
      normalizeImageMimeType(asset.mimeType) === mimeType &&
      asset.dataURL === dataURL,
  );
  if (existing) {
    return {
      asset: existing,
      deduplicated: true,
      width: existing.width ?? dimensions.width,
      height: existing.height ?? dimensions.height,
    };
  }

  const contentHash = await sha256Hex(bytes);
  const id = uniqueAssetId(`asset-${contentHash.slice(0, 24)}`, assets);
  return {
    asset: {
      id,
      dataURL,
      mimeType,
      created: (options?.now ?? Date.now)(),
      revision: 1,
      byteSize: blob.size,
      contentHash,
      width: dimensions.width,
      height: dimensions.height,
    },
    deduplicated: false,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function createWhiteboardImageElement(
  image: ImportedWhiteboardImage,
  viewport: WhiteboardViewport,
  createId: () => string = createOwnedElementId,
): WhiteboardElement {
  const maximumDisplaySize = 800;
  const scale = Math.min(
    1,
    maximumDisplaySize / Math.max(image.width, image.height),
  );
  const width = Math.max(1, image.width * scale);
  const height = Math.max(1, image.height * scale);
  const centerX = viewport.width / (2 * viewport.zoom) - viewport.x;
  const centerY = viewport.height / (2 * viewport.zoom) - viewport.y;
  const id = createId();

  return {
    ...createOwnedElementRuntimeFields(id),
    id,
    type: "image",
    isDeleted: false,
    fileId: image.asset.id,
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
  };
}

export function resolveWhiteboardAssets(
  elements: readonly WhiteboardElement[],
  ...sources: readonly Readonly<Record<string, WhiteboardAsset>>[]
): Record<string, WhiteboardAsset> {
  const referencedIds = new Set(
    elements.flatMap((element) =>
      !element.isDeleted &&
      element.type === "image" &&
      typeof element.fileId === "string"
        ? [element.fileId]
        : [],
    ),
  );
  const resolved: Record<string, WhiteboardAsset> = {};
  for (const id of [...referencedIds].sort()) {
    for (const source of sources) {
      const candidate = source[id];
      if (candidate?.id !== id) continue;
      if (!isSafeInlineImage(candidate)) continue;
      resolved[id] = candidate;
      break;
    }
  }
  return resolved;
}

export function pruneUnreferencedWhiteboardAssets(
  document: OwnedWhiteboardDocument,
): OwnedWhiteboardDocument {
  return {
    ...document,
    assets: resolveWhiteboardAssets(document.elements, document.assets),
  };
}

export function isSafeInlineImage(asset: WhiteboardAsset): boolean {
  const separator = asset.dataURL.search(/[;,]/);
  if (!asset.dataURL.startsWith("data:") || separator <= 5) return false;
  const sourceMimeType = normalizeImageMimeType(
    asset.dataURL.slice(5, separator),
  );
  const declaredMimeType = normalizeImageMimeType(asset.mimeType);
  const typesMatch =
    declaredMimeType === sourceMimeType ||
    declaredMimeType === "application/octet-stream";
  if (!RENDERABLE_IMAGE_MIME_TYPES.has(sourceMimeType) || !typesMatch) {
    return false;
  }
  return sourceMimeType !== "image/svg+xml" || isSafeSvgDataURL(asset.dataURL);
}

function isSafeSvgDataURL(dataURL: string): boolean {
  const separator = dataURL.indexOf(",");
  if (separator < 0) return false;
  try {
    const metadata = dataURL.slice(0, separator).toLowerCase();
    const payload = dataURL.slice(separator + 1);
    const svg = metadata.includes(";base64")
      ? atob(payload)
      : decodeURIComponent(payload);
    const withoutLocalReferences = svg
      .replace(/\b(?:href|xlink:href)\s*=\s*(["'])#[a-z_][\w:.-]*\1/gi, "")
      .replace(/\burl\s*\(\s*(["']?)#[a-z_][\w:.-]*\1\s*\)/gi, "");
    return !/<(?:script|foreignobject|iframe|object|embed|use|image|style)\b|<\?xml-stylesheet|<!entity|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|\burl\s*\(/i.test(
      withoutLocalReferences,
    );
  } catch {
    return false;
  }
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function uniqueAssetId(
  base: string,
  assets: Readonly<Record<string, WhiteboardAsset>>,
): string {
  if (!assets[base]) return base;
  let suffix = 2;
  while (assets[`${base}-${suffix}`]) suffix += 1;
  return `${base}-${suffix}`;
}

function readImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | null {
  if (mimeType === "image/png") return readPngDimensions(bytes);
  if (mimeType === "image/gif") return readGifDimensions(bytes);
  if (mimeType === "image/jpeg") return readJpegDimensions(bytes);
  if (mimeType === "image/webp") return readWebpDimensions(bytes);
  if (mimeType === "image/avif") return readAvifDimensions(bytes);
  return null;
}

function readPngDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (
    bytes.length < 24 ||
    !matches(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    return null;
  }
  return validDimensions(readUint32(bytes, 16), readUint32(bytes, 20));
}

function readGifDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (
    bytes.length < 10 ||
    (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a")
  ) {
    return null;
  }
  return validDimensions(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
}

function readJpegDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return validDimensions(
        readUint16(bytes, offset + 5),
        readUint16(bytes, offset + 3),
      );
    }
    if (marker === 0xda) return null;
    offset += length;
  }
  return null;
}

function readWebpDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const type = ascii(bytes, 12, 4);
  if (type === "VP8X") {
    return validDimensions(
      1 + readUint24LE(bytes, 24),
      1 + readUint24LE(bytes, 27),
    );
  }
  if (type === "VP8L" && bytes[20] === 0x2f) {
    const bits =
      bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return validDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (
    type === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return validDimensions(
      readUint16LE(bytes, 26) & 0x3fff,
      readUint16LE(bytes, 28) & 0x3fff,
    );
  }
  return null;
}

function readAvifDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (
    bytes.length < 24 ||
    ascii(bytes, 4, 4) !== "ftyp" ||
    !["avif", "avis"].includes(ascii(bytes, 8, 4))
  ) {
    return null;
  }
  for (let offset = 0; offset + 20 <= bytes.length; offset += 1) {
    if (!matchesAt(bytes, offset + 4, [0x69, 0x73, 0x70, 0x65])) continue;
    return validDimensions(
      readUint32(bytes, offset + 12),
      readUint32(bytes, offset + 16),
    );
  }
  return null;
}

function validDimensions(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | null {
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

function matches(bytes: Uint8Array, signature: readonly number[]): boolean {
  return matchesAt(bytes, 0, signature);
}

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  signature: readonly number[],
): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!)
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackContentHash(bytes);
  const digest = await subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function fallbackContentHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fallback-${(hash >>> 0).toString(16).padStart(8, "0")}-${bytes.length.toString(16)}`;
}
