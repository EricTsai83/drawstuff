import {
  AUTHORITY_LIMITS,
  authorityErrorSchema,
  registrationReceiptSchema,
} from "@drawstuff/collaboration/authority";
import {
  roomKeyGatewayRequestSchema,
  type RoomKeyResult,
} from "@drawstuff/collaboration/key-custody";
import { verifyRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { encodeBase64 } from "@drawstuff/collaboration/base64";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import { AdapterClient } from "./adapter-client.ts";
import type { RoomAuthority } from "./room-authority.ts";
import {
  keyWrapSecretReady,
  unwrapRoomKey,
  wrapRoomKey,
} from "./room-key-custody.ts";
import { createDoLogger, errorNameOf } from "./logger.ts";

/**
 * Releases or accepts Room's custody copy of the room key (plan 19). Same
 * identity, deadline and registration checks as the authority entry, but the
 * stricter key-holder role, and nothing here ever logs or echoes a key.
 */
export async function applyRoomKeyEntry(
  authority: RoomAuthority,
  input: unknown,
  env: Env,
): Promise<{ ok: true; result: RoomKeyResult } | { ok: false; error: string }> {
  const parsed = roomKeyGatewayRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "malformed" };
  const { proof, request } = parsed.data;
  if (request.roomId !== authority.roomId)
    return { ok: false, error: "not-found" };
  if (!keyWrapSecretReady(env.COLLAB_ROOM_KEY_WRAP_SECRET))
    return { ok: false, error: "unavailable" };
  const secret = env.COLLAB_ROOM_KEY_WRAP_SECRET;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    AUTHORITY_LIMITS.externalTimeoutMs,
  );
  try {
    const verified = verifyIdentityProof({
      token: proof,
      secret: env.COLLAB_IDENTITY_SECRET,
      expectedRoomId: authority.roomId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok) return { ok: false, error: "unauthorized" };
    if (
      request.deadline <= Date.now() ||
      request.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs
    )
      return { ok: false, error: "expired-operation" };
    const identity = verified.claims.identity;
    const authorize = () => {
      if (
        !(request.action === "escrow-room-key"
          ? authority.keyEscrowRole(identity)
          : authority.keyReleaseRole(identity))
      )
        throw new Error("forbidden");
    };
    authorize();
    const room = authority.state()!;
    const registration = await new AdapterClient(env).call(
      {
        v: 1,
        action: "register",
        operationId: request.operationId,
        roomId: authority.roomId,
        identity,
        ownerId: room.owner,
        sceneId: room.scene_id,
        create: false,
      },
      registrationReceiptSchema,
      controller.signal,
    );
    if (
      registration.roomId !== authority.roomId ||
      registration.operationId !== request.operationId ||
      registration.subject !== identity.subject ||
      registration.lifecycleVersion !== identity.lifecycleVersion ||
      registration.targetSubject !== undefined ||
      registration.targetVersion !== undefined
    )
      throw new Error("stale-proof");
    controller.signal.throwIfAborted();
    // Membership may have changed during I/O; recheck before releasing anything.
    authorize();
    const current = authority.state()!;
    const authGeneration = current.auth_generation;
    const custodied = authority.custodiedKey(authGeneration);

    if (request.action === "get-room-key") {
      if (!custodied)
        return {
          ok: true,
          result: {
            status: "absent",
            roomId: authority.roomId,
            authGeneration,
          },
        };
      return {
        ok: true,
        result: {
          status: "found",
          roomId: authority.roomId,
          authGeneration,
          roomKey: await unwrapRoomKey({
            secret,
            roomId: authority.roomId,
            authGeneration,
            wrapped: custodied.wrapped,
            wrapVersion: custodied.wrap_version,
          }),
        },
      };
    }

    if (
      request.authGeneration !== undefined &&
      request.authGeneration !== authGeneration
    )
      throw new Error("generation-mismatch");
    if (!current.key_check) throw new Error("initialization-incomplete");
    // Only the key this room was sealed with is accepted, so a wrong key can
    // never replace or poison the custody copy.
    const matches = await verifyRoomKeyCheck({
      roomKey: request.roomKey,
      roomId: authority.roomId,
      authGeneration,
      keyCheckBase64: encodeBase64(
        new Uint8Array(JSON.parse(current.key_check) as number[]),
      ),
    });
    if (!matches) throw new Error("operation-mismatch");
    if (custodied) {
      const existing = await unwrapRoomKey({
        secret,
        roomId: authority.roomId,
        authGeneration,
        wrapped: custodied.wrapped,
        wrapVersion: custodied.wrap_version,
      });
      if (existing !== request.roomKey) throw new Error("operation-mismatch");
    } else {
      const wrapped = await wrapRoomKey({
        secret,
        roomId: authority.roomId,
        authGeneration,
        roomKey: request.roomKey,
      });
      authority.custodyKey(
        authGeneration,
        wrapped.wrapped,
        wrapped.wrapVersion,
      );
    }
    // Holding the sealed key is what lets a link-admitted member reopen the
    // room from their list.
    authority.markKeyProven(identity.subject);
    return {
      ok: true,
      result: { status: "escrowed", roomId: authority.roomId, authGeneration },
    };
  } catch (error) {
    const code = authorityErrorSchema.safeParse(
      error instanceof Error ? error.message : undefined,
    );
    if (!code.success)
      createDoLogger(env.VERSION_METADATA).warn("room_key.entry_failed", {
        errorName: errorNameOf(error),
      });
    return { ok: false, error: code.success ? code.data : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
