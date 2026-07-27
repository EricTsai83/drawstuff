import type { WhiteboardAsset, WhiteboardElement } from "./contracts";

export function filterReferencedWhiteboardAssets(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>>,
): Record<string, WhiteboardAsset> {
  const referencedIds = new Set<string>();
  for (const element of elements) {
    if (
      !element.isDeleted &&
      element.type === "image" &&
      typeof element.fileId === "string"
    ) {
      referencedIds.add(element.fileId);
    }
  }

  return Object.fromEntries(
    [...referencedIds]
      .sort()
      .flatMap((id) => (assets[id] ? [[id, assets[id]]] : [])),
  );
}
