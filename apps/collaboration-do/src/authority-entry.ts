import {
  AUTHORITY_LIMITS,
  authorityErrorSchema,
  authorityGatewayRequestSchema,
  registrationReceiptSchema,
  roomCommandSchema,
  authorityStateSchema,
  authorityManagementSchema,
} from "@drawstuff/collaboration/authority";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import { AdapterClient } from "./adapter-client.ts";
import type { RoomAuthority } from "./room-authority.ts";

/** Called over the private DO binding. The public Gateway also requires its own service capability. */
export async function applyAuthorityEntry(
  authority: RoomAuthority,
  input: unknown,
  env: Env,
) {
  const parsed = authorityGatewayRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "malformed" };
  const { proof, request } = parsed.data;
  if (request.roomId !== authority.roomId)
    return { ok: false as const, error: "not-found" };
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
    if (!verified.ok) return { ok: false as const, error: "unauthorized" };
    if (
      request.deadline <= Date.now() ||
      request.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs
    )
      return { ok: false as const, error: "expired-operation" };
    const identity = verified.claims.identity;
    authority.authorizeRequest(identity, request);
    const room = authority.state();
    const creating = request.action === "create";
    const registration = await new AdapterClient(env).call(
      {
        v: 1,
        action: "register",
        operationId: request.operationId,
        roomId: authority.roomId,
        identity,
        ownerId: creating ? identity.subject : room!.owner,
        sceneId: creating ? request.sceneId : room!.scene_id,
        create: creating,
        ...(request.action === "set-member-role"
          ? { targetSubject: request.subject }
          : {}),
      },
      registrationReceiptSchema,
      controller.signal,
    );
    if (
      registration.roomId !== authority.roomId ||
      registration.operationId !== request.operationId ||
      registration.subject !== identity.subject ||
      registration.lifecycleVersion !== identity.lifecycleVersion ||
      (request.action === "set-member-role" &&
        (registration.targetSubject !== request.subject ||
          !registration.targetVersion)) ||
      (request.action !== "set-member-role" &&
        (registration.targetSubject !== undefined ||
          registration.targetVersion !== undefined))
    )
      throw new Error("stale-proof");
    controller.signal.throwIfAborted();
    // Local authority may have changed during I/O; recheck before querying or activating anything.
    authority.authorizeRequest(identity, request);
    if (request.action === "query")
      return {
        ok: true as const,
        result: authority.query(request.operationId)!,
      };
    if (request.action === "get-state" || request.action === "get-management") {
      const current = authority.state()!;
      const role =
        current.owner === identity.subject ? "owner" : authority.role(identity);
      if (!role) throw new Error("forbidden");
      return {
        ok: true as const,
        result: (request.action === "get-management"
          ? authorityManagementSchema
          : authorityStateSchema
        ).parse({
          ...(request.action === "get-management"
            ? authority.management(
                identity,
                request.cursor,
                request.emailCursor,
              )
            : {}),
          roomId: authority.roomId,
          state: current.state,
          role,
          sceneId: current.scene_id,
          label: current.label,
          linkRole: current.link_role,
          authGeneration: current.auth_generation,
          authRevision: current.auth_revision,
          authorityEpoch: current.authority_epoch,
          initializationDeadline: current.initialization_deadline,
          keyCheck: current.key_check
            ? (JSON.parse(current.key_check) as unknown)
            : null,
        }),
      };
    }
    const command = roomCommandSchema.parse({
      ...request,
      actor: identity,
      ...(request.action === "join"
        ? { registrationVersion: registration.lifecycleVersion }
        : {}),
      ...(request.action === "set-member-role"
        ? { registrationVersion: registration.targetVersion }
        : {}),
      ...(request.action === "set-key-check"
        ? { keyCheck: new Uint8Array(request.keyCheck) }
        : {}),
    });
    return { ok: true as const, result: await authority.apply(command) };
  } catch (error) {
    const code = authorityErrorSchema.safeParse(
      error instanceof Error ? error.message : undefined,
    );
    return {
      ok: false as const,
      error: code.success ? code.data : "unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}
