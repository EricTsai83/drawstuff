import type { WhiteboardElement } from "../contracts";

export function createOwnedElementRuntimeFields(
  id: string,
  position = 0,
): {
  readonly index: string;
  readonly seed: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly updatedAt: number;
  readonly groupIds: readonly string[];
  readonly frameId: string | null;
} {
  const nonce = hashString(`${id}:${Date.now()}:${position}`);
  return {
    index: ownedElementIndex(position),
    seed: hashString(id),
    version: 1,
    versionNonce: nonce,
    updatedAt: Date.now(),
    groupIds: [],
    frameId: null,
  };
}

export function commitOwnedElement(
  previous: WhiteboardElement,
  next: WhiteboardElement,
): WhiteboardElement {
  if (
    "version" in previous &&
    "versionNonce" in previous &&
    "updatedAt" in previous
  ) {
    return {
      ...next,
      version: previous.version + 1,
      versionNonce: nextVersionNonce(previous.versionNonce),
      updatedAt: Date.now(),
    };
  }
  return next;
}

export function ownedElementIndex(position: number): string {
  return `a${Math.max(0, position).toString(36).padStart(10, "0")}`;
}

function nextVersionNonce(value: number): number {
  let next = value | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
