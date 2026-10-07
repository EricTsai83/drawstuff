import type { RoomId, SyncedElement } from "@drawstuff/collaboration/protocol";
import { encodeCollaborationSnapshot } from "@drawstuff/collaboration/snapshot";

// Valid canvas JSON, including the actual encrypted attachment reference.
// ASCII text padding makes both the typical and exact maximum size reproducible.
export function canvasFixture(
  roomId: RoomId,
  size: number,
  fileId?: string,
): Uint8Array {
  const elements: SyncedElement[] = [];
  if (fileId)
    elements.push({
      id: "image",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      type: "image",
      fileId,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  const text = {
    id: "text",
    version: 1,
    versionNonce: 2,
    isDeleted: false,
    type: "text",
    text: "",
  };
  elements.push(text);
  const base = encodeCollaborationSnapshot({ roomId, elements });
  if (!base.ok || base.bytes.length > size)
    throw new Error("invalid canvas fixture size");
  text.text = "x".repeat(size - base.bytes.length);
  const encoded = encodeCollaborationSnapshot({ roomId, elements });
  if (!encoded.ok || encoded.bytes.length !== size)
    throw new Error("canvas fixture size mismatch");
  return encoded.bytes;
}
