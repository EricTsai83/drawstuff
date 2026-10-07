import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { SnapshotApi } from "@/lib/collab/snapshot-http";

export function emptySnapshotApi(
  roomId: RoomId,
  authGeneration: number,
  write?: SnapshotApi["write"],
): SnapshotApi {
  return {
    read: async () => ({
      found: false,
      bytes: null,
      receipt: { roomId, authGeneration, authorityEpoch: 1, revision: 0 },
    }),
    write:
      write ??
      (async (operation) => ({
        status: "written",
        revision: operation.expectedRevision + 1,
      })),
    query: async () => ({ status: "pending" }),
    cancel: async () => ({ status: "cancelled" }),
  };
}
