import { z } from "zod";
import {
  authorityVersionSchema,
  contentResultSchema,
  initializationManifestSchema,
  type AdapterCommand,
  type DurableJob,
} from "@drawstuff/collaboration/authority";
import type { AdapterClient } from "./adapter-client.ts";
import type { RoomAuthority } from "./room-authority.ts";

const fenceResponse = z.strictObject({
  authorityEpoch: authorityVersionSchema,
});
const projectionResponse = z.strictObject({ applied: z.boolean() });
const cleanupResponse = z.strictObject({ cleaned: z.literal(true) });
const initializationResponse = z.strictObject({
  manifest: initializationManifestSchema,
});

/** All network I/O occurs outside SQLite transactions; acknowledgments recheck current local state. */
export class RoomDelivery {
  constructor(
    private readonly authority: RoomAuthority,
    private readonly adapter: AdapterClient,
  ) {}

  async deliver(job: DurableJob, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const room = this.authority.state();
    switch (job.kind) {
      case "projection":
        if (job.event.roomId !== this.authority.roomId)
          throw new Error("wrong-room");
        // applied=false is a durable obsolete/negative decision, not a delivery failure.
        await this.adapter.call(
          { v: 1, action: "project", event: job.event },
          projectionResponse,
          signal,
        );
        return true;
      case "fence": {
        if (job.roomId !== this.authority.roomId || !room)
          throw new Error("wrong-room");
        if (job.authorityEpoch < room.authority_epoch) return true;
        if (job.authorityEpoch !== room.authority_epoch)
          throw new Error("invalid-fence");
        await this.fence(
          {
            v: 1,
            action: "fence",
            roomId: job.roomId,
            authorityEpoch: room.authority_epoch,
            authGeneration: room.auth_generation,
            state: room.state,
            initializationDeadline: room.initialization_deadline,
          },
          signal,
        );
        return true;
      }
      case "settle-content": {
        if (job.operation.roomId !== this.authority.roomId)
          throw new Error("wrong-room");
        if (
          this.authority.contentResult(job.operation.operationId)?.status !==
          "pending"
        )
          return true;
        let result = await this.adapter.call(
          { v: 1, action: "query", operation: job.operation },
          contentResultSchema,
          signal,
        );
        if (result.status === "pending") {
          if (job.operation.deadline > Date.now()) return false;
          result = await this.adapter.call(
            { v: 1, action: "cancel", operation: job.operation },
            contentResultSchema,
            signal,
          );
        }
        if (result.status === "pending") return false;
        await this.authority.settleContent(job.operation.operationId, result);
        return true;
      }
      case "initialize": {
        if (job.roomId !== this.authority.roomId || !room)
          throw new Error("wrong-room");
        const result = this.authority.query(job.operationId);
        if (result?.status !== "pending") return true;
        if (
          !this.authority.canConfirmInitialization(
            job.operationId,
            job.manifest,
          )
        )
          return false;
        const context = {
          v: 1 as const,
          roomId: job.roomId,
          authorityEpoch: result.authorityEpoch,
          authGeneration: job.manifest.authGeneration,
        };
        const verified = await this.adapter.call(
          {
            ...context,
            action: "verify-initialization",
            manifest: job.manifest,
          },
          initializationResponse,
          signal,
        );
        if (JSON.stringify(verified.manifest) !== JSON.stringify(job.manifest))
          throw new Error("operation-mismatch");
        if (
          !this.authority.canConfirmInitialization(
            job.operationId,
            job.manifest,
          )
        )
          return false;
        // Adapter ready acknowledgment precedes local ready. Lost replies repeat both idempotent calls.
        await this.fence(
          { ...context, action: "fence", state: "ready" },
          signal,
        );
        await this.authority.confirmInitialization(
          job.operationId,
          verified.manifest,
        );
        return true;
      }
      case "cleanup":
        if (job.roomId !== this.authority.roomId || !room)
          throw new Error("wrong-room");
        if (room.state !== "ended" || room.fenced_epoch < room.authority_epoch)
          return false;
        await this.adapter.call(
          {
            v: 1,
            action: "cleanup",
            roomId: job.roomId,
            authorityEpoch: room.authority_epoch,
            authGeneration: room.auth_generation,
          },
          cleanupResponse,
          signal,
        );
        return true;
      case "retire":
        throw new Error("lifecycle-adapter-unconfigured");
    }
  }

  private async fence(
    command: Extract<AdapterCommand, { action: "fence" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const ack = await this.adapter.call(command, fenceResponse, signal);
    // A future adapter epoch indicates skew. Never acknowledge work we have not applied locally.
    if (ack.authorityEpoch !== command.authorityEpoch)
      throw new Error("invalid-fence");
    await this.authority.confirmFence(command.authorityEpoch);
  }
}
