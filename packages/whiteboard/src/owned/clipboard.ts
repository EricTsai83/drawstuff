import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "../contracts";
import {
  createPersistedWhiteboardDocumentV3,
  parseWhiteboardDocumentV3,
  toRuntimeWhiteboardDocumentV3,
} from "../v3-document";

export const OWNED_CLIPBOARD_MIME = "application/x-drawstuff-whiteboard+json";
export const OWNED_CLIPBOARD_VERSION = 1 as const;
const MAX_CLIPBOARD_BYTES = 5_000_000;

export interface OwnedClipboardPayloadV1 {
  readonly version: typeof OWNED_CLIPBOARD_VERSION;
  readonly elements: readonly WhiteboardElement[];
  readonly assets: Readonly<Record<string, WhiteboardAsset>>;
}

export interface OwnedPasteResult {
  readonly elements: readonly WhiteboardElement[];
  readonly assets: readonly WhiteboardAsset[];
}

export function createOwnedClipboardPayload(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): OwnedClipboardPayloadV1 {
  const referencedAssets: Record<string, WhiteboardAsset> = {};
  for (const element of elements) {
    const fileId = element.type === "image" ? element.fileId : null;
    if (typeof fileId !== "string") continue;
    const asset = assets[fileId];
    if (asset) referencedAssets[fileId] = asset;
  }
  const normalized = normalizeClipboardContents(elements, referencedAssets);
  return {
    version: OWNED_CLIPBOARD_VERSION,
    elements: normalized.elements,
    assets: normalized.assets,
  };
}

export function serializeOwnedClipboardPayload(
  payload: OwnedClipboardPayloadV1,
): string {
  return JSON.stringify(payload);
}

export function isOwnedClipboardPayloadSizeAllowed(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_CLIPBOARD_BYTES;
}

export function parseOwnedClipboardPayload(
  value: string,
): OwnedClipboardPayloadV1 | null {
  if (value.length === 0 || !isOwnedClipboardPayloadSizeAllowed(value)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== OWNED_CLIPBOARD_VERSION) {
      return null;
    }
    const normalized = parseClipboardContents(parsed.elements, parsed.assets);
    if (normalized.elements.length === 0) return null;
    return {
      version: OWNED_CLIPBOARD_VERSION,
      elements: normalized.elements,
      assets: normalized.assets,
    };
  } catch {
    return null;
  }
}

function parseClipboardContents(
  elements: unknown,
  assets: unknown,
): Pick<OwnedWhiteboardDocument, "elements" | "assets"> {
  if (!Array.isArray(elements) || !isRecord(assets)) {
    throw new Error("Clipboard payload is malformed");
  }
  const persistedAssets = Object.fromEntries(
    Object.entries(assets).map(([id, asset]) => {
      if (!isRecord(asset)) throw new Error("Clipboard asset is malformed");
      return [id, { ...asset, storage: "inline", revision: 1 }] as const;
    }),
  );
  return toRuntimeWhiteboardDocumentV3(
    parseWhiteboardDocumentV3({
      version: 3,
      elements,
      assets: persistedAssets,
      metadata: {
        name: "Clipboard",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    }),
  );
}

function normalizeClipboardContents(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): Pick<OwnedWhiteboardDocument, "elements" | "assets"> {
  const normalized = toRuntimeWhiteboardDocumentV3(
    createPersistedWhiteboardDocumentV3({
      elements,
      assets,
      state: {
        name: "Clipboard",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    }),
  );
  return {
    elements: normalized.elements,
    assets: normalized.assets,
  };
}

export function remapOwnedClipboardPayload(
  payload: OwnedClipboardPayloadV1,
  existingElementIds: ReadonlySet<string>,
  existingAssetIds: ReadonlySet<string>,
  createId: () => string,
  offset: number,
): OwnedPasteResult {
  const reservedIds = new Set([...existingElementIds, ...existingAssetIds]);
  const assetIdMap = new Map<string, string>();
  const assets = Object.values(payload.assets).map((asset) => {
    const id = uniqueId(createId, reservedIds, "asset");
    assetIdMap.set(asset.id, id);
    return { ...asset, id };
  });
  const elementIdMap = new Map(
    payload.elements.map((element) => [
      element.id,
      uniqueId(createId, reservedIds, "element"),
    ]),
  );
  const elements: WhiteboardElement[] = payload.elements.map((element) => {
    const id = elementIdMap.get(element.id)!;
    const fileId =
      element.type === "image" && typeof element.fileId === "string"
        ? (assetIdMap.get(element.fileId) ?? null)
        : null;
    const moved = {
      ...element,
      id,
      x: finiteNumber(element.x, 0) + offset,
      y: finiteNumber(element.y, 0) + offset,
    };
    return element.type === "image" ? { ...moved, fileId } : moved;
  });
  return { elements, assets };
}

function uniqueId(
  createId: () => string,
  reserved: Set<string>,
  prefix: string,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = createId();
    if (candidate.length > 0 && !reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
  let suffix = reserved.size;
  while (reserved.has(`${prefix}-${suffix}`)) suffix += 1;
  const fallback = `${prefix}-${suffix}`;
  reserved.add(fallback);
  return fallback;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
