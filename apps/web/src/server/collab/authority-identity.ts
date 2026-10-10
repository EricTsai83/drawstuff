import "server-only";
import { and, eq, gt } from "drizzle-orm";
import {
  normalizeAccountEmail,
  trustedIdentitySchema,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import { DEFAULT_IDENTITY_PROOF_TTL_SECONDS } from "@drawstuff/collaboration/room-auth";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";
import { session, user } from "@/server/db/schema";
import type { Database, RoomTransaction } from "./rooms";
import { lockOrCreateLifecycleSubject } from "./authority-lifecycle-lock";
import { AdapterError } from "./authority-storage";

/** Lock lifecycle before account/session/scene rows. Registration and future freeze use this same order. */
export async function lockActiveAccount(
  tx: RoomTransaction,
  subject: string,
): Promise<TrustedIdentity> {
  const scope = `account:${subject}`;
  const lifecycle = await lockOrCreateLifecycleSubject(tx, {
    scope,
    kind: "account",
    subject,
  });
  if (!lifecycle || lifecycle.frozen || lifecycle.retired)
    throw new AdapterError("fence-mismatch");
  const [account] = await tx
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, subject))
    .for("key share");
  if (!account?.emailVerified) throw new AdapterError("not-found");
  return trustedIdentitySchema.parse({
    subject: account.id,
    email: normalizeAccountEmail(account.email),
    lifecycleVersion: lifecycle.version,
  });
}

/** No room role lookup. Re-read the live account/session, rather than trusting cached auth.user metadata. */
export async function issueAuthorityIdentity(
  db: Database,
  params: {
    subject: string;
    sessionId: string;
    roomId: string;
    expectedIdentity?: TrustedIdentity;
  },
  secret: string,
) {
  const roomId = roomIdSchema.parse(params.roomId);
  return db.transaction(async (tx) => {
    const identity = await lockActiveAccount(tx, params.subject);
    if (
      params.expectedIdentity &&
      JSON.stringify(identity) !==
        JSON.stringify(trustedIdentitySchema.parse(params.expectedIdentity))
    )
      throw new AdapterError("fence-mismatch");
    const [activeSession] = await tx
      .select({ id: session.id })
      .from(session)
      .where(
        and(
          eq(session.id, params.sessionId),
          eq(session.userId, identity.subject),
          gt(session.expiresAt, new Date()),
        ),
      )
      .for("key share");
    if (!activeSession) throw new AdapterError("not-found");
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + DEFAULT_IDENTITY_PROOF_TTL_SECONDS;
    return {
      proof: signIdentityProof(
        {
          v: 1,
          aud: "drawstuff-room-identity",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          jti: crypto.randomUUID(),
          iat,
          exp,
          roomId,
          identity,
        },
        secret,
      ),
      expiresAt: exp * 1000,
    };
  });
}
