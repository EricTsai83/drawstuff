import { vi } from "vitest";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import type { ContentResult } from "@drawstuff/collaboration/authority";
import {
  SnapshotHttpError,
  type SnapshotApi,
} from "@/lib/collab/snapshot-http";

/** Fake Room/storage effects; the real store codec and transport are tested around it. */
export function binarySnapshotBackend(roomId: RoomId) {
  let revision = 0;
  let authorityEpoch = 1;
  let snapshot:
    | Extract<Awaited<ReturnType<SnapshotApi["read"]>>, { found: true }>
    | undefined;
  const results = new Map<string, ContentResult>();
  const write = vi.fn<SnapshotApi["write"]>(async (operation, bytes) => {
    const old = results.get(operation.operationId);
    if (old) return old;
    if (operation.deadline <= Date.now()) return { status: "refused" };
    if (
      operation.expectedRevision !== revision ||
      operation.authorityEpoch !== authorityEpoch
    ) {
      results.set(operation.operationId, { status: "conflict" });
      return { status: "conflict" };
    }
    revision++;
    snapshot =
      operation.kind === "snapshot-reset"
        ? undefined
        : {
            found: true,
            bytes: bytes.slice(),
            receipt: {
              roomId,
              authorityEpoch,
              revision,
              byteLength: bytes.byteLength,
              checksum: operation.checksum,
            },
          };
    const result = { status: "written" as const, revision };
    results.set(operation.operationId, result);
    return result;
  });
  const api: SnapshotApi = {
    read: vi.fn<SnapshotApi["read"]>(
      async () =>
        snapshot ?? {
          found: false,
          bytes: null,
          receipt: { roomId, authorityEpoch, revision },
        },
    ),
    write,
    query: vi.fn<SnapshotApi["query"]>(async (operation) => {
      const result = results.get(operation.operationId);
      if (!result) throw new SnapshotHttpError(404, "not-found");
      return result;
    }),
    cancel: vi.fn<SnapshotApi["cancel"]>(async (operation) => {
      const existing = results.get(operation.operationId);
      const result =
        existing && existing.status !== "pending"
          ? existing
          : { status: "cancelled" as const };
      results.set(operation.operationId, result);
      return result;
    }),
  };
  return {
    api,
    write,
    results,
    commit: write.getMockImplementation()!,
    emptyAt(nextRevision: number, epoch = authorityEpoch) {
      revision = nextRevision;
      authorityEpoch = epoch;
      snapshot = undefined;
    },
  };
}
