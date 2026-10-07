import { AUTHORITY_LIMITS } from "@drawstuff/collaboration/authority";
import type { RoomId, SyncedElement } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  decodeCollaborationSnapshot,
  deriveSnapshotKey,
  encodeCollaborationSnapshot,
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  openCollaborationSnapshot,
  sealCollaborationSnapshot,
  snapshotCiphertextChecksum,
  SNAPSHOT_CRYPTO_VERSION,
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
  | { status: "unreadable"; reason: "wrong-key" | "malformed" | "unavailable" };
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

/** Keys and plaintext stay here; the transport only handles encrypted bytes. */
export async function createCollaborationSnapshotStore(options: {
  api: SnapshotApi;
  roomId: RoomId;
  roomKey: RoomKey;
  authGeneration: number;
}): Promise<CollaborationSnapshotStore> {
  const { api, roomId, authGeneration } = options;
  const key = await deriveSnapshotKey({
    roomKey: options.roomKey,
    roomId,
    authGeneration,
  });
  const writer = createSnapshotWriter(api);
  let authorityEpoch: number | undefined;
  return {
    hasPendingWrite: writer.hasPending,
    async load() {
      authorityEpoch = undefined;
      try {
        const response = await api.read(snapshotReadRequest(roomId));
        const { receipt } = response;
        // Even an empty snapshot from a rotated generation is not our baseline.
        if (receipt.authGeneration !== authGeneration) {
          authorityEpoch = undefined;
          return { status: "unreadable", reason: "wrong-key" };
        }
        if (!response.found) {
          authorityEpoch = receipt.authorityEpoch;
          return { status: "empty", revision: receipt.revision };
        }
        const { bytes } = response;
        if (
          bytes.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES ||
          bytes.byteLength !== response.receipt.byteLength ||
          response.receipt.cryptoVersion !== SNAPSHOT_CRYPTO_VERSION ||
          (await snapshotCiphertextChecksum(bytes)) !==
            response.receipt.checksum
        )
          return { status: "unreadable", reason: "malformed" };
        const opened = await openCollaborationSnapshot({
          key,
          ciphertext: bytes,
          roomId,
          authGeneration,
          revision: receipt.revision,
        });
        if (!opened.ok) return { status: "unreadable", reason: "wrong-key" };
        const decoded = decodeCollaborationSnapshot(opened.plaintext, {
          roomId,
        });
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
      try {
        // This private fingerprint never crosses the wire. A recovered receipt
        // must not confirm edits or a revision/authority context it did not save.
        const fingerprint = JSON.stringify([
          await snapshotCiphertextChecksum(encoded.bytes),
          expectedRevision,
          authGeneration,
          epoch,
        ]);
        const { result, operation, matches } = await writer.run({
          fingerprint,
          intent,
          create: async () => {
            const sealed = await sealCollaborationSnapshot({
              key,
              plaintext: encoded.bytes,
              roomId,
              authGeneration,
              revision: expectedRevision + 1,
            });
            if (!sealed.ok) throw new Error("snapshot-seal-failed");
            return {
              bytes: sealed.ciphertext,
              operation: {
                v: 1,
                kind: "snapshot-put",
                roomId,
                operationId: crypto.randomUUID(),
                deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
                authGeneration,
                authorityEpoch: epoch,
                expectedRevision,
                checksum: await snapshotCiphertextChecksum(sealed.ciphertext),
              },
            };
          },
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
