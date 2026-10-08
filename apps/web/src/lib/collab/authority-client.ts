import { TRPCClientError } from "@trpc/client";
import {
  AUTHORITY_LIMITS,
  authorityStateSchema,
  managementResultSchema,
  type AuthorityRequest,
} from "@drawstuff/collaboration/authority";
import { encodeBase64 } from "@drawstuff/collaboration/base64";
import type { RoomId } from "@drawstuff/collaboration/protocol";

export type AuthorityApi = {
  execute: (request: AuthorityRequest) => Promise<unknown>;
  identity: (input: { roomId: RoomId }) => Promise<{
    proof: string;
    expiresAt: number;
    relayUrl: string;
  }>;
};
export class AuthorityRoomError extends Error {
  constructor(
    readonly code:
      | "initializing"
      | "ended"
      | "pending"
      | "cancelled"
      | "expired-operation"
      | "attachments-required"
      | "generation-mismatch",
  ) {
    super(`Collaboration operation is not complete: ${code}`);
  }
}
export const authorityEnvelope = (roomId: RoomId) => ({
  v: 1 as const,
  roomId,
  operationId: crypto.randomUUID(),
  deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
});

export async function readAuthorityState(
  api: Pick<AuthorityApi, "execute">,
  roomId: RoomId,
) {
  const state = authorityStateSchema.parse(
    await api.execute({ ...authorityEnvelope(roomId), action: "get-state" }),
  );
  if (state.roomId !== roomId) throw new Error("authority-room-mismatch");
  return state;
}

/** Display metadata never becomes a role-bearing token: the socket grants its current Room role. */
export function createAuthorityRoomBackend(api: AuthorityApi) {
  const getRoom = async ({ roomId }: { roomId: RoomId }) => {
    const state = await readAuthorityState(api, roomId);
    if (state.state !== "ready") throw new AuthorityRoomError(state.state);
    return {
      roomId,
      sceneId: state.sceneId,
      authGeneration: state.authGeneration,
      role: state.role,
      keyCheckBase64: state.keyCheck
        ? encodeBase64(new Uint8Array(state.keyCheck))
        : null,
    };
  };
  return {
    getRoom,
    async joinRoom(input: { roomId: RoomId; authGeneration?: number }) {
      const state = await readAuthorityState(api, input.roomId);
      if (
        input.authGeneration !== undefined &&
        state.authGeneration !== input.authGeneration
      )
        throw new AuthorityRoomError("generation-mismatch");
      if (state.state !== "ready") throw new AuthorityRoomError(state.state);
      const room = {
        roomId: state.roomId,
        sceneId: state.sceneId,
        authGeneration: state.authGeneration,
        role: state.role,
      };
      const identity = await api.identity({ roomId: input.roomId });
      return { ...room, token: identity.proof, relayUrl: identity.relayUrl };
    },
  };
}

type Mutation = Exclude<
  AuthorityRequest,
  { action: "get-state" | "get-management" | "query" }
>;
/** One immutable management intent, retained across unknown outcomes and UI retries. */
export function createAuthorityOperation(
  api: Pick<AuthorityApi, "execute">,
  request: Mutation,
) {
  const intent = structuredClone(request);
  let attempted = false;
  // The confirmed receipt's projection flag: whether "My rooms" may still lag.
  let confirmed: { projectionPending: boolean } | undefined;
  return async (): Promise<{ projectionPending: boolean }> => {
    if (confirmed) return confirmed;
    let result: unknown;
    if (attempted) {
      try {
        result = await api.execute({
          ...authorityEnvelope(intent.roomId),
          action: "query",
          operationId: intent.operationId,
        });
      } catch (error) {
        if (
          !(error instanceof TRPCClientError) ||
          (error.data as { code?: unknown } | undefined)?.code !== "NOT_FOUND"
        )
          throw error;
      }
    }
    if (result === undefined) {
      if (intent.deadline <= Date.now())
        throw new AuthorityRoomError("expired-operation");
      attempted = true;
      result = await api.execute(intent);
    }
    const receipt = managementResultSchema.parse(result);
    if (receipt.operationId !== intent.operationId)
      throw new Error("authority-operation-mismatch");
    if (receipt.status !== "enforced")
      throw new AuthorityRoomError(receipt.status);
    confirmed = { projectionPending: receipt.projectionPending };
    return confirmed;
  };
}
