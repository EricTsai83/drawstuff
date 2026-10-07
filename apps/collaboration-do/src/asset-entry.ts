import { z } from "zod";
import {
  AUTHORITY_LIMITS,
  assetGatewayRequestSchema,
  authorityErrorSchema,
  registrationReceiptSchema,
  contentOperationSchema,
  contentResultSchema,
  type AssetGatewayResult,
} from "@drawstuff/collaboration/authority";
import {
  canonicalizeAssetIds,
  collaborationAssetRecordSchema,
} from "@drawstuff/collaboration/asset";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import type { RoomAuthority } from "./room-authority.ts";
import { AdapterClient } from "./adapter-client.ts";

/** Metadata only: UploadThing receives ciphertext; Room authorizes discovery and finalization. */
export async function applyAssetEntry(
  authority: RoomAuthority,
  input: unknown,
  env: Env,
): Promise<
  { ok: true; result: AssetGatewayResult } | { ok: false; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    AUTHORITY_LIMITS.externalTimeoutMs,
  );
  try {
    const parsed = assetGatewayRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "malformed" };
    const { proof, request } = parsed.data;
    const intent = request.action === "read" ? request : request.intent;
    if (intent.roomId !== authority.roomId) throw new Error("not-found");
    const verified = verifyIdentityProof({
      token: proof,
      secret: env.COLLAB_IDENTITY_SECRET,
      expectedRoomId: authority.roomId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok) return { ok: false, error: "unauthorized" };
    const identity = verified.claims.identity;
    const writing =
      request.action === "prepare" || request.action === "finalize";
    const authorize = () => {
      controller.signal.throwIfAborted();
      if (verified.claims.exp * 1000 <= Date.now())
        throw new Error("stale-proof");
      const role = authority.role(identity, true);
      if (!role || (writing && role === "viewer")) throw new Error("forbidden");
      const room = authority.state()!;
      if (!room.parent_confirmed) throw new Error("initializing");
      if (
        room.state === "initializing" &&
        room.initialization_deadline <= Date.now()
      )
        throw new Error("expired-operation");
    };
    authorize();
    const room = authority.state()!;
    const adapter = new AdapterClient(env);
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
      registration.lifecycleVersion !== identity.lifecycleVersion ||
      registration.targetSubject !== undefined ||
      registration.targetVersion !== undefined
    )
      throw new Error("stale-proof");
    authorize();
    if (request.action === "read") {
      const validateDeadline = () => {
        if (
          intent.deadline <= Date.now() ||
          intent.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs
        )
          throw new Error("expired-operation");
      };
      validateDeadline();
      const current = authority.state()!;
      const assetIds = canonicalizeAssetIds(request.fileIds);
      const { assets } = await adapter.call(
        {
          v: 1,
          action: "read-assets",
          roomId: intent.roomId,
          authGeneration: current.auth_generation,
          authorityEpoch: current.authority_epoch,
          assetIds,
        },
        z.strictObject({
          assets: z.array(collaborationAssetRecordSchema).max(assetIds.length),
        }),
        controller.signal,
      );
      authorize();
      validateDeadline();
      const latest = authority.state()!;
      if (
        latest.auth_generation !== current.auth_generation ||
        latest.authority_epoch !== current.authority_epoch
      )
        throw new Error("generation-mismatch");
      const present = new Set(assets.map((asset) => asset.excalidrawFileId));
      if (
        present.size !== assets.length ||
        assets.some((asset) => !assetIds.includes(asset.excalidrawFileId))
      )
        throw new Error("invalid-response");
      return {
        ok: true,
        result: {
          roomId: authority.roomId,
          authGeneration: current.auth_generation,
          assets,
          missing: assetIds.filter((id) => !present.has(id)),
        },
      };
    }
    if (request.action === "prepare") {
      if (
        intent.deadline <= Date.now() ||
        intent.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs
      )
        throw new Error("expired-operation");
      const current = authority.state()!;
      if (
        request.intent.authGeneration !== current.auth_generation ||
        request.intent.authorityEpoch !== current.authority_epoch
      )
        throw new Error("generation-mismatch");
      return {
        ok: true,
        result: {
          status: "authorized",
          authGeneration: current.auth_generation,
          authorityEpoch: current.authority_epoch,
        },
      };
    }
    let operation = authority.assetContent(request.intent, identity);
    let result;
    if (request.action === "finalize") {
      if (
        request.asset.excalidrawFileId !== request.intent.excalidrawFileId ||
        request.asset.cryptoVersion !== request.intent.cryptoVersion ||
        request.asset.byteLength !== request.intent.byteLength
      )
        throw new Error("operation-mismatch");
      const { excalidrawFileId, cryptoVersion, byteLength, ...base } =
        request.intent;
      void excalidrawFileId;
      void cryptoVersion;
      void byteLength;
      operation = contentOperationSchema.parse({
        ...base,
        actor: identity,
        asset: request.asset,
      });
      result = await authority.acceptContent(operation);
      authorize();
      if (result.status === "pending")
        result = await adapter.call(
          { v: 1, action: "write", operation },
          contentResultSchema,
          controller.signal,
        );
    } else {
      if (!operation)
        return {
          ok: true,
          result: {
            status: "absent",
            expired: request.intent.deadline <= Date.now(),
          },
        };
      result = authority.queryContent(operation)!;
      if (result.status === "pending")
        result = await adapter.call(
          { v: 1, action: request.action, operation },
          contentResultSchema,
          controller.signal,
        );
    }
    await authority.settleContent(operation.operationId, result);
    authorize();
    return { ok: true, result };
  } catch (error) {
    const code = authorityErrorSchema.safeParse(
      error instanceof Error ? error.message : undefined,
    );
    return { ok: false, error: code.success ? code.data : "unavailable" };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
