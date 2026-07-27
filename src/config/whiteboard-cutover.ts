export function requiresCanonicalWhiteboardReads(): boolean {
  return process.env.NEXT_PUBLIC_WHITEBOARD_V2_READ_CUTOVER === "true";
}
