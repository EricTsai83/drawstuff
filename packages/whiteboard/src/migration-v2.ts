import type { WhiteboardDocumentV3, WhiteboardElementV3 } from "./contracts";
import type { WhiteboardElementV2 } from "./migration-v2-contracts";
import {
  parseWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "./canonical-document";
import {
  createPersistedWhiteboardDocumentV3,
  createWhiteboardDocumentV3,
} from "./v3-document";

export {
  createPersistedWhiteboardDocumentV2,
  createWhiteboardDocumentV2,
  externalizeWhiteboardDocumentAssetsV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  toRuntimeWhiteboardDocumentV2,
} from "./canonical-document";
export type {
  WhiteboardAssetV2,
  WhiteboardDocumentV2,
  WhiteboardElementV2,
} from "./migration-v2-contracts";

/**
 * Server-only deterministic migration. Keep this subpath out of client imports.
 */
export function migrateWhiteboardDocumentV2(
  input: unknown,
): WhiteboardDocumentV3 {
  const source = parseWhiteboardDocumentV2(input);
  const runtime = toRuntimeWhiteboardDocumentV2(source);
  const migrated = createPersistedWhiteboardDocumentV3(
    {
      ...runtime,
      elements: runtime.elements.map(migrateElementV2),
      assets: Object.fromEntries(
        Object.entries(source.assets).map(([id, asset]) => [
          id,
          {
            id,
            dataURL:
              asset.storage === "inline"
                ? asset.dataURL
                : `data:${asset.mimeType};base64,`,
            mimeType: asset.mimeType,
            created: asset.created,
            lastRetrieved: asset.lastRetrieved,
            byteSize: asset.byteSize,
            contentHash: asset.contentHash,
            width: asset.width,
            height: asset.height,
            revision: 1,
          },
        ]),
      ),
    },
    { now: 0 },
  );
  return createWhiteboardDocumentV3({
    ...migrated,
    assets: Object.fromEntries(
      Object.entries(source.assets).map(([id, asset]) => [
        id,
        {
          ...asset,
          revision: 1,
        },
      ]),
    ),
  });
}

function migrateElementV2(
  element: WhiteboardElementV2,
  position: number,
): WhiteboardElementV3 {
  const base = {
    id: element.id,
    isDeleted: element.isDeleted,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    opacity: element.opacity,
    roughness: element.roughness,
    ...(element.roundness ? { roundness: element.roundness } : {}),
    locked: element.locked,
    index: `a${position.toString(36).padStart(10, "0")}`,
    seed: hashString(element.id),
    version: 1,
    versionNonce: hashString(`${element.id}:version`),
    updatedAt: 0,
    groupIds: [],
    frameId: null,
  } as const;
  if (element.type === "text") {
    return {
      ...base,
      type: "text",
      text: element.text,
      originalText: element.originalText,
      fontSize: element.fontSize,
      lineHeight: element.lineHeight,
      fontFamily: "excalifont",
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
    };
  }
  if (element.type === "arrow" || element.type === "line") {
    return {
      ...base,
      type: element.type,
      points: element.points,
      startArrowhead: null,
      endArrowhead: element.type === "arrow" ? "arrow" : null,
      startBinding: null,
      endBinding: null,
      elbowed: false,
      fixedSegments: [],
    };
  }
  if (element.type === "freedraw") {
    return {
      ...base,
      type: "freedraw",
      points: element.points,
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: element.points.at(-1) ?? null,
    };
  }
  if (element.type === "image") {
    return {
      ...base,
      type: "image",
      fileId: element.fileId,
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
  }
  if (element.type === "frame") {
    return { ...base, type: "frame", name: "" };
  }
  return { ...base, type: element.type };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
