import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import { snapshotCiphertextChecksum } from "@drawstuff/collaboration/snapshot";
import { snapshotReadRequest, type SnapshotApi } from "./snapshot-http";
import { createSnapshotWriter } from "./snapshot-writer";

/** Retain an unconfirmed owner reset across button retries, including lost replies. */
export function createSnapshotReset(api: SnapshotApi, roomId: RoomId) {
  const writer = createSnapshotWriter(api);
  return async () => {
    const { result } = await writer.run({
      fingerprint: roomId,
      create: async () => {
        const { receipt } = await api.read(snapshotReadRequest(roomId));
        const bytes = new Uint8Array();
        return {
          bytes,
          operation: {
            v: 1,
            kind: "snapshot-reset",
            roomId,
            operationId: crypto.randomUUID(),
            deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
            authGeneration: receipt.authGeneration,
            authorityEpoch: receipt.authorityEpoch,
            expectedRevision: receipt.revision,
            checksum: await snapshotCiphertextChecksum(bytes),
          },
        };
      },
    });
    if (result.status !== "written")
      throw new Error(
        "Snapshot reset was not confirmed. Retry to query the same operation.",
      );
    return result;
  };
}
