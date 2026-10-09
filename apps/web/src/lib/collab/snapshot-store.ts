import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import type { RoomId, SyncedElement } from "@drawstuff/collaboration/protocol";
import {
  decodeCollaborationSnapshot,
  encodeCollaborationSnapshot,
  MAX_SNAPSHOT_BYTES,
  snapshotChecksum,
} from "@drawstuff/collaboration/snapshot";
import { rateLimitRetryAfterMs } from "./rate-limit";
import { snapshotReadRequest, type SnapshotApi } from "./snapshot-http";
import { createSnapshotWriter } from "./snapshot-writer";

export type { SnapshotApi } from "./snapshot-http";
type LoadSnapshotResult =
  | {
      status: "loaded";
      revision: number;
      elements: readonly SyncedElement[];
      checksum?: string;
    }
  | { status: "empty"; revision?: number }
  | { status: "unreadable"; reason: "malformed" | "unavailable" };
export type SaveSnapshotResult =
  | { status: "written"; revision: number; checksum?: string }
  | { status: "conflict"; currentRevision: number | undefined }
  | { status: "oversize"; byteLength: number; maxByteLength: number }
  | { status: "rate-limited"; retryAfterMs: number }
  | { status: "failed" };
export type CollaborationSnapshotStore = {
  load: () => Promise<LoadSnapshotResult>;
  hasPendingWrite?: () => boolean;
  save: (input: {
    elements: readonly SyncedElement[];
    expectedRevision: number;
    intent?: "cadence" | "leave";
  }) => Promise<SaveSnapshotResult>;
};

/** Encodes and decodes the room snapshot; the transport only handles bytes. */
export function createCollaborationSnapshotStore(options: {
  api: SnapshotApi;
  roomId: RoomId;
}): CollaborationSnapshotStore {
  const { api, roomId } = options;
  const writer = createSnapshotWriter(api);
  let authorityEpoch: number | undefined;
  return {
    hasPendingWrite: writer.hasPending,
    async load() {
      authorityEpoch = undefined;
      try {
        const response = await api.read(snapshotReadRequest(roomId));
        const { receipt } = response;
        if (!response.found) {
          authorityEpoch = receipt.authorityEpoch;
          return { status: "empty", revision: receipt.revision };
        }
        const { bytes } = response;
        if (
          bytes.byteLength > MAX_SNAPSHOT_BYTES ||
          bytes.byteLength !== response.receipt.byteLength ||
          (await snapshotChecksum(bytes)) !== response.receipt.checksum
        )
          return { status: "unreadable", reason: "malformed" };
        const decoded = decodeCollaborationSnapshot(bytes, { roomId });
        if (!decoded.ok) return { status: "unreadable", reason: "malformed" };
        authorityEpoch = receipt.authorityEpoch;
        return {
          status: "loaded",
          revision: receipt.revision,
          elements: decoded.snapshot.elements,
          checksum: response.receipt.checksum,
        };
      } catch {
        return { status: "unreadable", reason: "unavailable" };
      }
    },
    async save({ elements, expectedRevision, intent = "cadence" }) {
      const encoded = encodeCollaborationSnapshot({ roomId, elements });
      if (!encoded.ok)
        return encoded.error.code === "oversize-snapshot"
          ? {
              status: "oversize",
              byteLength: encoded.error.byteLength,
              maxByteLength: encoded.error.maxByteLength,
            }
          : { status: "failed" };
      if (authorityEpoch === undefined) return { status: "failed" };
      const epoch = authorityEpoch;
      const bytes = encoded.bytes;
      try {
        const checksum = await snapshotChecksum(bytes);
        // This private fingerprint never crosses the wire. A recovered receipt
        // must not confirm edits or a revision/authority context it did not save.
        const fingerprint = JSON.stringify([checksum, expectedRevision, epoch]);
        const { result, operation, matches } = await writer.run({
          fingerprint,
          intent,
          create: () =>
            Promise.resolve({
              bytes,
              operation: {
                v: 1,
                kind: "snapshot-put",
                roomId,
                operationId: crypto.randomUUID(),
                deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
                authorityEpoch: epoch,
                expectedRevision,
                checksum,
              },
            }),
        });
        if (result.status === "written")
          return matches && authorityEpoch === operation.authorityEpoch
            ? {
                status: "written",
                revision: result.revision,
                checksum: operation.checksum,
              }
            : { status: "conflict", currentRevision: result.revision };
        if (result.status === "pending") return { status: "failed" };
        // Terminal refusal/conflict/cancellation requires a fresh baseline and
        // authority epoch; no new operation is minted against stale metadata.
        authorityEpoch = undefined;
        return { status: "conflict", currentRevision: undefined };
      } catch (error) {
        const retryAfterMs = rateLimitRetryAfterMs(error);
        return retryAfterMs !== null
          ? { status: "rate-limited", retryAfterMs }
          : { status: "failed" };
      }
    },
  };
}
