import "server-only";
import { TRPCError } from "@trpc/server";
import { env } from "@/env";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import {
  type AssetRequest,
  type AssetUploadIntent,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { issueAuthorityIdentity } from "./authority-identity";
import { callAssetGateway } from "./asset-gateway";
import {
  collaborationRoomsDisabled,
  collaborationRoomsDisabledError,
} from "./relay-routing";
import type { Database } from "./rooms";
import { queueAuthorityAssetOrphan } from "./authority-storage";

export async function requestAssetAuthority(
  db: Database,
  account: {
    subject: string;
    sessionId: string;
    expectedIdentity?: TrustedIdentity;
  },
  request: AssetRequest,
) {
  if (collaborationRoomsDisabled()) throw collaborationRoomsDisabledError();
  if (!env.COLLAB_IDENTITY_SECRET || !env.COLLAB_AUTHORITY_SECRET)
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
  const roomId =
    request.action === "read" ? request.roomId : request.intent.roomId;
  const identity = await issueAuthorityIdentity(
    db,
    { ...account, roomId },
    env.COLLAB_IDENTITY_SECRET,
  );
  const result = await callAssetGateway(
    { url: env.COLLAB_CONTROL_URL, secret: env.COLLAB_AUTHORITY_SECRET },
    identity.proof,
    request,
  );
  return { result, proof: identity.proof };
}

export async function prepareAuthorityAssetUpload(
  db: Database,
  account: { subject: string; sessionId: string },
  intent: AssetUploadIntent,
) {
  const { result, proof } = await requestAssetAuthority(db, account, {
    action: "prepare",
    intent,
  });
  if (
    !("status" in result) ||
    result.status !== "authorized" ||
    result.authGeneration !== intent.authGeneration ||
    result.authorityEpoch !== intent.authorityEpoch
  )
    throw new Error("upload-not-authorized");
  const verified = verifyIdentityProof({
    token: proof,
    secret: env.COLLAB_IDENTITY_SECRET!,
    expectedRoomId: intent.roomId,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) throw new Error("stale-proof");
  return {
    intent,
    actor: verified.claims.identity,
    sessionId: account.sessionId,
  };
}

/** Only the verified provider callback supplies the object descriptor. Unknown outcomes enter locked deferred cleanup. */
export async function finalizeAuthorityAssetUpload(
  db: Database,
  metadata: {
    intent: AssetUploadIntent;
    actor: TrustedIdentity;
    sessionId: string;
  },
  file: { key: string; ufsUrl: string; size: number },
) {
  try {
    if (file.size !== metadata.intent.byteLength)
      throw new Error("asset-size-mismatch");
    const { result } = await requestAssetAuthority(
      db,
      {
        subject: metadata.actor.subject,
        sessionId: metadata.sessionId,
        expectedIdentity: metadata.actor,
      },
      {
        action: "finalize",
        intent: metadata.intent,
        asset: {
          excalidrawFileId: metadata.intent.excalidrawFileId,
          cryptoVersion: metadata.intent.cryptoVersion,
          byteLength: file.size,
          url: file.ufsUrl,
          utFileKey: file.key,
        },
      },
    );
    if (
      !("status" in result) ||
      !["written", "pending"].includes(result.status)
    ) {
      throw new Error("asset-not-finalized");
    }
    return result;
  } catch {
    // Never immediately delete: a write may have committed before its reply was lost.
    try {
      await queueAuthorityAssetOrphan(db, file.key, metadata.intent.roomId);
    } catch {
      // Provider SDK logs callback errors. Driver errors may contain storage keys in SQL params.
      throw new Error("asset-cleanup-unconfirmed");
    }
    // UploadThing sends callback-result only when onUploadComplete resolves.
    // Unknown is deliberately not a content result: the client retains its
    // original intent and queries it before attempting another provider upload.
    return { status: "unknown" as const };
  }
}
