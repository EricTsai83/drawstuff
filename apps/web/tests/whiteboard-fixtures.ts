import type {
  WhiteboardBoxElementV3,
  WhiteboardImageElementV3,
} from "@drawstuff/whiteboard";

export function rectangleV3(
  id: string,
  update: Partial<WhiteboardBoxElementV3> = {},
): WhiteboardBoxElementV3 {
  return {
    index: `a-${id}`,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 1,
    seed: stableNumber(id),
    version: 1,
    versionNonce: stableNumber(`${id}:version`),
    updatedAt: 1,
    groupIds: [],
    frameId: null,
    locked: false,
    ...update,
    id,
    type: "rectangle",
  };
}

export function imageV3(
  id: string,
  fileId: string | null,
  update: Partial<WhiteboardImageElementV3> = {},
): WhiteboardImageElementV3 {
  return {
    ...rectangleV3(id),
    fileId,
    status: fileId ? "saved" : "pending",
    scale: [1, 1],
    crop: null,
    ...update,
    id,
    type: "image",
  };
}

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
