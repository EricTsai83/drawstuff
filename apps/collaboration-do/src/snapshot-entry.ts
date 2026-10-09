import { createHash } from "node:crypto";
import type { PerformanceTimings } from "@drawstuff/collaboration/performance";
import {
  ADAPTER_METADATA_MAX_BYTES,
  AUTHORITY_LIMITS,
  SNAPSHOT_REQUEST_HEADER,
  SNAPSHOT_RECEIPT_HEADER,
  snapshotGatewayRequestSchema,
  registrationReceiptSchema,
  contentOperationSchema,
  contentResultSchema,
  authorityErrorSchema,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { MAX_SNAPSHOT_BYTES } from "@drawstuff/collaboration/snapshot";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import type { RoomAuthority } from "./room-authority.ts";
import { AdapterClient } from "./adapter-client.ts";
import { closedJsonResponse } from "./internal.ts";
import { readSnapshotBody, SnapshotTransferError } from "./snapshot-body.ts";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Two bounded bodies per Room, never a room-wide lock or durable payload staging. */
export class SnapshotEntry {
  private transfers = 0;
  constructor(
    private readonly authority: RoomAuthority,
    private readonly env: Env,
  ) {}

  async handle(http: Request, timings?: PerformanceTimings): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      AUTHORITY_LIMITS.externalTimeoutMs,
    );
    let reserved = false;
    let responseOwnsTransfer = false;
    const release = () => {
      clearTimeout(timer);
      if (reserved) {
        this.transfers--;
        reserved = false;
      }
    };
    try {
      if (http.method !== "POST")
        return closedJsonResponse(405, "method-not-allowed");
      const metadata = http.headers.get(SNAPSHOT_REQUEST_HEADER);
      if (
        !metadata ||
        new TextEncoder().encode(metadata).byteLength >
          ADAPTER_METADATA_MAX_BYTES
      )
        return closedJsonResponse(400, "malformed");
      let input: unknown;
      try {
        input = JSON.parse(metadata) as unknown;
      } catch {
        return closedJsonResponse(400, "malformed");
      }
      const parsed = snapshotGatewayRequestSchema.safeParse(input);
      if (!parsed.success) return closedJsonResponse(400, "malformed");
      const { proof, request } = parsed.data;
      const intent = request.action === "read" ? request : request.operation;
      if (intent.roomId !== this.authority.roomId)
        return closedJsonResponse(404, "not-found");
      const verified = verifyIdentityProof({
        token: proof,
        secret: this.env.COLLAB_IDENTITY_SECRET,
        expectedRoomId: this.authority.roomId,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!verified.ok) return closedJsonResponse(401, "unauthorized");
      const identity = verified.claims.identity;
      const bodyTransfer =
        request.action === "read" ||
        (request.action === "write" &&
          request.operation.kind === "snapshot-put");
      if (bodyTransfer) {
        if (this.transfers >= AUTHORITY_LIMITS.bodyTransfers)
          return closedJsonResponse(429, "capacity");
        this.transfers++;
        reserved = true;
      }
      const writing = request.action === "write";
      const authorize = () => {
        controller.signal.throwIfAborted();
        if (verified.claims.exp * 1000 <= Date.now())
          throw new SnapshotTransferError("unauthorized", 401);
        if (request.action === "read" && request.deadline <= Date.now())
          throw new Error("expired-operation");
        this.authorize(
          identity,
          writing,
          request.action !== "read" &&
            request.operation.kind === "snapshot-reset",
        );
      };
      authorize();
      if (
        request.action === "read" &&
        (request.deadline <= Date.now() ||
          request.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs)
      )
        throw new Error("expired-operation");
      const operation =
        request.action === "read"
          ? undefined
          : contentOperationSchema.parse({
              ...request.operation,
              actor: identity,
            });
      // Query/cancel never invent an intent, and cannot read another actor's receipt.
      if (operation && !writing && !this.authority.queryContent(operation))
        throw new Error("not-found");
      const room = this.authority.state()!;
      const adapter = new AdapterClient(this.env, undefined, timings);
      const registration = await adapter.call(
        {
          v: 1,
          action: "register",
          operationId: intent.operationId,
          roomId: intent.roomId,
          identity,
          ownerId: room.owner,
          sceneId: room.scene_id,
          create: false,
        },
        registrationReceiptSchema,
        controller.signal,
      );
      if (
        registration.roomId !== intent.roomId ||
        registration.operationId !== intent.operationId ||
        registration.subject !== identity.subject ||
        registration.lifecycleVersion !== identity.lifecycleVersion
      )
        throw new Error("stale-proof");
      authorize();
      if (request.action === "read") {
        await readSnapshotBody(http.body, 0, controller.signal);
        const current = this.authority.state()!;
        const context = {
          v: 1 as const,
          action: "read-snapshot" as const,
          roomId: intent.roomId,
          authorityEpoch: current.authority_epoch,
        };
        const snapshot = await adapter.readSnapshot(context, controller.signal);
        const authorizeRead = () => {
          authorize();
          if (
            this.authority.state()!.authority_epoch !== context.authorityEpoch
          )
            throw new Error("epoch-mismatch");
        };
        authorizeRead();
        if (!snapshot.found)
          return closedJsonResponse(404, "not-found", {
            "cache-control": "no-store",
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(snapshot.receipt),
          });
        const snapshotBytes = snapshot.bytes;
        if (!this.validBytes(snapshotBytes, snapshot.receipt.checksum))
          throw new Error("invalid-body");
        let offset = 0;
        // Hold the quota until consumption/cancellation. Recheck before each bounded delivery chunk.
        const stream = new ReadableStream({
          type: "bytes",
          start: (streamController) => {
            controller.signal.addEventListener(
              "abort",
              () => {
                streamController.error(new Error("snapshot-timeout"));
                release();
              },
              { once: true },
            );
          },
          pull: (streamController) => {
            try {
              authorizeRead();
              if (offset === snapshotBytes.byteLength) {
                streamController.close();
                release();
                return;
              }
              const end = Math.min(offset + 65_536, snapshotBytes.byteLength);
              streamController.enqueue(snapshotBytes.slice(offset, end));
              offset = end;
            } catch (error) {
              streamController.error(error);
              release();
            }
          },
          cancel: release,
        });
        responseOwnsTransfer = true;
        return new Response(stream, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(snapshot.receipt),
          },
        });
      }
      if (!operation) throw new Error("not-found");
      let result;
      if (writing) {
        const acceptStart = performance.now();
        result = await this.authority.acceptContent(operation);
        if (timings) timings.acceptContent = performance.now() - acceptStart;
        authorize();
        const bodyStart = performance.now();
        const bytes = await readSnapshotBody(
          http.body,
          operation.kind === "snapshot-put" ? MAX_SNAPSHOT_BYTES : 0,
          controller.signal,
        );
        if (timings) timings.receiveBody = performance.now() - bodyStart;
        if (
          (operation.kind === "snapshot-put" &&
            !this.validBytes(bytes, operation.checksum)) ||
          (operation.kind === "snapshot-reset" &&
            digest(bytes) !== operation.checksum)
        )
          throw new SnapshotTransferError("invalid-body", 400);
        authorize();
        if (result.status === "pending") {
          // State may change while receiving bytes. The adapter also checks the persisted epoch under its lock.
          if (
            operation.authorityEpoch !== this.authority.state()!.authority_epoch
          )
            throw new Error("epoch-mismatch");
          result = await adapter.writeSnapshot(
            operation,
            operation.kind === "snapshot-put" ? bytes : undefined,
            controller.signal,
          );
        }
      } else {
        await readSnapshotBody(http.body, 0, controller.signal);
        result = this.authority.queryContent(operation)!;
        if (result.status === "pending")
          result = await adapter.call(
            { v: 1, action: request.action, operation },
            contentResultSchema,
            controller.signal,
          );
      }
      const settleStart = performance.now();
      await this.authority.settleContent(operation.operationId, result);
      if (timings) timings.settleContent = performance.now() - settleStart;
      // A committed receipt remains recoverable even if access changed during the write.
      authorize();
      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof SnapshotTransferError)
        return closedJsonResponse(error.status, error.message);
      const code = authorityErrorSchema.safeParse(
        error instanceof Error ? error.message : undefined,
      );
      return closedJsonResponse(
        code.success
          ? code.data === "forbidden"
            ? 403
            : code.data === "not-found"
              ? 404
              : 409
          : 503,
        code.success ? code.data : "unavailable",
      );
    } finally {
      if (!responseOwnsTransfer) {
        controller.abort();
        release();
        await http.body?.cancel().catch(() => undefined);
      }
    }
  }

  private authorize(
    identity: TrustedIdentity,
    writing: boolean,
    reset: boolean,
  ) {
    const role = this.authority.role(identity, true);
    if (
      !role ||
      (writing && role === "viewer") ||
      (writing && reset && role !== "owner")
    )
      throw new Error("forbidden");
    if (!this.authority.state()!.parent_confirmed)
      throw new Error("initializing");
    const room = this.authority.state()!;
    if (
      room.state === "initializing" &&
      room.initialization_deadline <= Date.now()
    )
      throw new Error("expired-operation");
  }
  private validBytes(bytes: Uint8Array, checksum: string) {
    return (
      bytes.byteLength > 0 &&
      bytes.byteLength <= MAX_SNAPSHOT_BYTES &&
      digest(bytes) === checksum
    );
  }
}
