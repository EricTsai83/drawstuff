import type { ContentResult } from "@drawstuff/collaboration/authority";
import {
  SnapshotHttpError,
  type SnapshotApi,
  type SnapshotOperation,
} from "./snapshot-http";

/** One in-memory sealed payload; durable jobs retain only its immutable intent. */
export function createSnapshotWriter(api: SnapshotApi) {
  let pending:
    | { operation: SnapshotOperation; bytes: Uint8Array; fingerprint: string }
    | undefined;
  let active = false;
  return {
    hasPending: () => pending !== undefined,
    async run(input: {
      fingerprint: string;
      intent?: "cadence" | "leave";
      create: () => Promise<{
        operation: SnapshotOperation;
        bytes: Uint8Array;
      }>;
    }) {
      if (active) throw new Error("snapshot-write-in-progress");
      active = true;
      try {
        const recovering = pending !== undefined;
        pending ??= {
          ...(await input.create()),
          fingerprint: input.fingerprint,
        };
        const current = pending;
        let result: ContentResult = { status: "pending" };
        if (recovering) {
          try {
            result = await api.query(current.operation);
          } catch (error) {
            if (
              !(error instanceof SnapshotHttpError) ||
              error.status !== 404 ||
              error.code !== "not-found"
            )
              throw error;
            // No accepted intent can arrive after its original deadline. Before
            // that deadline, retry exactly the same intent and bytes.
            if (current.operation.deadline <= Date.now())
              result = { status: "refused" };
          }
        }
        if (result.status === "pending") {
          result =
            current.operation.deadline <= Date.now()
              ? await api.cancel(current.operation)
              : await api.write(current.operation, current.bytes, input.intent);
        }
        if (
          result.status === "written" &&
          result.revision !== current.operation.expectedRevision + 1
        )
          throw new Error("snapshot-revision-mismatch");
        if (result.status !== "pending") pending = undefined;
        return {
          result,
          operation: current.operation,
          matches: current.fingerprint === input.fingerprint,
        };
      } finally {
        active = false;
      }
    },
  };
}
