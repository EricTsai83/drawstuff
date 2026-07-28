import { TRPCError } from "@trpc/server";

export const WHITEBOARD_MAINTENANCE_CODE = "WHITEBOARD_MAINTENANCE";
export const WHITEBOARD_MAINTENANCE_MESSAGE =
  "Whiteboard maintenance is in progress. Your local canvas is safe; save and share will be available again shortly.";

export function areWhiteboardWritesPaused(): boolean {
  return process.env.WHITEBOARD_WRITES_PAUSED === "true";
}

export function assertWhiteboardWritesEnabled(): void {
  if (!areWhiteboardWritesPaused()) return;
  throw new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message: WHITEBOARD_MAINTENANCE_CODE,
    cause: {
      code: WHITEBOARD_MAINTENANCE_CODE,
      status: 503,
    },
  });
}
