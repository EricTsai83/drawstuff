import "server-only";

import { normalizeAccountEmail } from "@drawstuff/collaboration/authority";
import { eq, sql } from "drizzle-orm";

import {
  collaborationLifecycleRegistration,
  collaborationRoom,
  user,
} from "@/server/db/schema";
import { lockOrCreateLifecycleSubject } from "./authority-lifecycle-lock";
import type { Database } from "./rooms";

export class InviteeRetiringError extends Error {
  constructor() {
    super("This account is being removed and cannot be invited.");
    this.name = "InviteeRetiringError";
  }
}

/**
 * Registers an invitation before the Room accepts it, the same way a join or
 * create registers before activation. When the email belongs to an account,
 * its lifecycle row is locked first — the lock account retirement's freeze
 * takes — so either the registration commits before the freeze and
 * retirement enumerates this room, or the freeze committed first and the
 * invitation is refused. An email with no account needs nothing: by the time
 * such an account exists and retires, the invitation's projection is in Neon.
 */
export async function registerInvitation(
  db: Database,
  input: { roomId: string; email: string; operationId: string },
): Promise<void> {
  const key = normalizeAccountEmail(input.email);
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(trim(${user.email}))`, key))
      .limit(1);
    if (!account) return;
    const lifecycle = await lockOrCreateLifecycleSubject(tx, {
      scope: `account:${account.id}`,
      kind: "account",
      subject: account.id,
    });
    if (!lifecycle || lifecycle.frozen || lifecycle.retired)
      throw new InviteeRetiringError();
    // A registration must name the room's scene, like the one a later join
    // writes; a room not yet in Neon has no scene to name, and retirement
    // finds it through the invite projection instead.
    const [room] = await tx
      .select({ sceneId: collaborationRoom.sceneId })
      .from(collaborationRoom)
      .where(eq(collaborationRoom.roomId, input.roomId));
    if (!room) return;
    await tx
      .insert(collaborationLifecycleRegistration)
      .values({
        subject: account.id,
        roomId: input.roomId,
        sceneId: room.sceneId,
        owner: false,
        lifecycleVersion: lifecycle.version,
        operationId: input.operationId,
      })
      .onConflictDoNothing();
  });
}
