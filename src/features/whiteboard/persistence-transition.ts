import { detectWhiteboardDocumentFormat } from "./document-format";

export type WhiteboardWriteTransition = "safe" | "unsafe-downgrade";

export function classifyWhiteboardWriteTransition(
  currentPayload: unknown,
  nextPayload: unknown,
): WhiteboardWriteTransition {
  const currentFormat = detectWhiteboardDocumentFormat(currentPayload);
  const nextFormat = detectWhiteboardDocumentFormat(nextPayload);
  return currentFormat === "whiteboard-v1" && nextFormat === "legacy-excalidraw"
    ? "unsafe-downgrade"
    : "safe";
}
