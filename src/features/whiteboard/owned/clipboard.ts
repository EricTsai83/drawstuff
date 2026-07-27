import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard/contracts";
import {
  createPersistedWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "@/features/whiteboard/canonical-document";

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
    const fileId = element.fileId;
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
    const normalized = normalizeClipboardContents(
      Array.isArray(parsed.elements)
        ? (parsed.elements as readonly WhiteboardElement[])
        : [],
      isRecord(parsed.assets)
        ? (parsed.assets as Readonly<Record<string, WhiteboardAsset>>)
        : {},
    );
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

function normalizeClipboardContents(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): Pick<WhiteboardDocument, "elements" | "assets"> {
  const normalized = toRuntimeWhiteboardDocumentV2(
    createPersistedWhiteboardDocumentV2({
      elements: elements.map(removeStaleVariantFields),
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

function removeStaleVariantFields(
  element: WhiteboardElement,
): WhiteboardElement {
  const normalized = {
    ...(element as unknown as Readonly<Record<string, unknown>>),
  };
  if (
    element.type !== "arrow" &&
    element.type !== "freedraw" &&
    element.type !== "line"
  ) {
    delete normalized.points;
  }
  if (element.type !== "image") {
    delete normalized.fileId;
  }
  if (element.type !== "text") {
    delete normalized.text;
    delete normalized.originalText;
    delete normalized.fontSize;
    delete normalized.lineHeight;
  }
  return normalized as unknown as WhiteboardElement;
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
  const groupIdMap = new Map<string, string>();
  for (const element of payload.elements) {
    const record = asRecord(element);
    for (const groupId of readStringArray(record.groupIds)) {
      if (!groupIdMap.has(groupId)) {
        groupIdMap.set(groupId, uniqueId(createId, reservedIds, "group"));
      }
    }
  }
  const elements = payload.elements.map((element) => {
    const id = elementIdMap.get(element.id)!;
    const fileId =
      typeof element.fileId === "string"
        ? (assetIdMap.get(element.fileId) ?? null)
        : element.fileId;
    return {
      ...element,
      ...remapElementReferences(element, elementIdMap, groupIdMap),
      id,
      x: finiteNumber(element.x, 0) + offset,
      y: finiteNumber(element.y, 0) + offset,
      ...(fileId === undefined ? {} : { fileId }),
    };
  });
  return { elements, assets };
}

function remapElementReferences(
  element: WhiteboardElement,
  elementIds: ReadonlyMap<string, string>,
  groupIds: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const record = asRecord(element);
  const update: Record<string, unknown> = {};
  if ("groupIds" in record) {
    update.groupIds = readStringArray(record.groupIds).flatMap((id) => {
      const remapped = groupIds.get(id);
      return remapped ? [remapped] : [];
    });
  }
  for (const key of ["containerId", "frameId"] as const) {
    if (key in record) {
      update[key] =
        typeof record[key] === "string"
          ? (elementIds.get(record[key]) ?? null)
          : null;
    }
  }
  if (Array.isArray(record.boundElementIds)) {
    update.boundElementIds = readStringArray(record.boundElementIds).flatMap(
      (id) => {
        const remapped = elementIds.get(id);
        return remapped ? [remapped] : [];
      },
    );
  }
  if (Array.isArray(record.boundElements)) {
    update.boundElements = record.boundElements.flatMap((binding: unknown) => {
      if (!isRecord(binding) || typeof binding.id !== "string") return [];
      const id = elementIds.get(binding.id);
      return id ? [{ ...binding, id }] : [];
    });
  }
  for (const key of ["startBinding", "endBinding"] as const) {
    if (!(key in record)) continue;
    const binding = record[key];
    if (!isRecord(binding) || typeof binding.elementId !== "string") {
      update[key] = null;
      continue;
    }
    const elementId = elementIds.get(binding.elementId);
    update[key] = elementId ? { ...binding, elementId } : null;
  }
  return update;
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

function asRecord(value: WhiteboardElement): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
