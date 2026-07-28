import {
  parseWhiteboardDocumentV3,
  type WhiteboardElement,
  type WhiteboardElementType,
} from "@drawstuff/whiteboard";

const ELEMENT_TYPES: readonly WhiteboardElementType[] = [
  "arrow",
  "diamond",
  "ellipse",
  "embeddable",
  "frame",
  "freedraw",
  "iframe",
  "image",
  "line",
  "magicframe",
  "rectangle",
  "text",
];

export function createTestElementV3(
  update: Readonly<Record<string, unknown>> = {},
): WhiteboardElement {
  const type = readElementType(update.type);
  const id = readString(update.id, "element");
  const variant =
    type === "text"
      ? {
          text: "",
          originalText: "",
          fontFamily: "excalifont",
          fontSize: 20,
          lineHeight: 1.25,
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          autoResize: true,
        }
      : type === "arrow" || type === "line"
        ? {
            points: [
              [0, 0],
              [100, 50],
            ],
            startArrowhead: null,
            endArrowhead: type === "arrow" ? "arrow" : null,
            startBinding: null,
            endBinding: null,
            elbowed: false,
            fixedSegments: [],
          }
        : type === "freedraw"
          ? {
              points: [
                [0, 0],
                [100, 50],
              ],
              pressures: [],
              simulatePressure: true,
              lastCommittedPoint: [100, 50],
            }
          : type === "image"
            ? {
                fileId: null,
                status: "saved",
                scale: [1, 1],
                crop: null,
              }
            : type === "frame"
              ? { name: "" }
              : {};
  const element: Readonly<Record<string, unknown>> = {
    index: readString(update.index, `a-${id}`),
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
    ...variant,
    ...update,
    id,
    type,
  };
  const fileId =
    type === "image" && typeof element.fileId === "string"
      ? element.fileId
      : null;
  const assets = fileId
    ? {
        [fileId]: {
          id: fileId,
          mimeType: "image/png",
          created: 1,
          storage: "external",
          revision: 1,
        },
      }
    : {};
  const referencedIds = [
    ...(type === "text" && typeof element.containerId === "string"
      ? [element.containerId]
      : []),
    ...(type === "arrow" || type === "line"
      ? [element.startBinding, element.endBinding].flatMap((binding) =>
          binding &&
          typeof binding === "object" &&
          "elementId" in binding &&
          typeof binding.elementId === "string"
            ? [binding.elementId]
            : [],
        )
      : []),
  ].filter((referencedId) => referencedId !== id);
  const referencedElements = [...new Set(referencedIds)].map(
    (referencedId, position) => ({
      ...createReferenceElement(referencedId),
      index: `ref-${position}-${referencedId}`,
    }),
  );
  const document = parseWhiteboardDocumentV3({
    version: 3,
    elements: [...referencedElements, element],
    assets,
    metadata: {
      name: "Test",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  });
  const parsed = document.elements.find((candidate) => candidate.id === id);
  if (!parsed) throw new Error("Test element fixture did not parse");
  return parsed;
}

function createReferenceElement(id: string): Readonly<Record<string, unknown>> {
  return {
    id,
    type: "rectangle",
    index: `ref-${id}`,
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
  };
}

function readElementType(value: unknown): WhiteboardElementType {
  return typeof value === "string"
    ? (ELEMENT_TYPES.find((type) => type === value) ?? "rectangle")
    : "rectangle";
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
