import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { type Database } from "@/server/collab/rooms";
import { account, adminGrant, user } from "@/server/db/schema";

export async function getActiveOperatorGrant(db: Database, userId: string) {
  return db.query.adminGrant.findFirst({
    where: and(
      eq(adminGrant.userId, userId),
      eq(adminGrant.role, "operator"),
      isNull(adminGrant.revokedAt),
    ),
    columns: { userId: true, role: true },
  });
}

async function requireVerifiedGoogleUser(db: Database, userId: string) {
  const target = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { id: true, emailVerified: true },
  });
  if (!target)
    throw new TRPCError({ code: "NOT_FOUND", message: "Account not found." });
  if (!target.emailVerified) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The account email is not verified.",
    });
  }
  const googleAccount = await db.query.account.findFirst({
    where: and(eq(account.userId, userId), eq(account.providerId, "google")),
    columns: { id: true },
  });
  if (!googleAccount) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The account is not linked to Google.",
    });
  }
}

export async function grantOperator(params: {
  db: Database;
  actorUserId: string;
  targetUserId: string;
}): Promise<{ granted: true; alreadyActive: boolean }> {
  await requireVerifiedGoogleUser(params.db, params.targetUserId);
  const existing = await params.db.query.adminGrant.findFirst({
    where: and(
      eq(adminGrant.userId, params.targetUserId),
      isNull(adminGrant.revokedAt),
    ),
    columns: { userId: true },
  });
  if (existing) return { granted: true, alreadyActive: true };

  await params.db
    .insert(adminGrant)
    .values({
      userId: params.targetUserId,
      role: "operator",
      grantSource: "operator",
      grantedByUserId: params.actorUserId,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: adminGrant.userId,
      set: {
        role: "operator",
        grantSource: "operator",
        grantedByUserId: params.actorUserId,
        grantedAt: new Date(),
        revokedAt: null,
      },
    });
  return { granted: true, alreadyActive: false };
}

export async function revokeOperator(params: {
  db: Database;
  actorUserId: string;
  targetUserId: string;
}): Promise<{ revoked: true }> {
  if (params.actorUserId === params.targetUserId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An operator cannot revoke their own access.",
    });
  }
  const [revoked] = await params.db
    .update(adminGrant)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(adminGrant.userId, params.targetUserId),
        isNull(adminGrant.revokedAt),
      ),
    )
    .returning({ userId: adminGrant.userId });
  if (!revoked) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Active operator grant not found.",
    });
  }
  return { revoked: true };
}
