import "server-only";
import { eq } from "drizzle-orm";
import { collaborationLifecycleSubject } from "@/server/db/schema";
import type { RoomTransaction } from "./rooms";

/** Existing subjects need only the lock; missing ones are inserted then re-read. */
export async function lockOrCreateLifecycleSubject(
  tx: RoomTransaction,
  initial: Pick<
    typeof collaborationLifecycleSubject.$inferInsert,
    "scope" | "kind" | "subject" | "sceneId"
  >,
) {
  const readLocked = () =>
    tx
      .select()
      .from(collaborationLifecycleSubject)
      .where(eq(collaborationLifecycleSubject.scope, initial.scope))
      .for("update");
  const [existing] = await readLocked();
  if (existing) return existing;
  await tx
    .insert(collaborationLifecycleSubject)
    .values(initial)
    .onConflictDoNothing();
  // A concurrent initializer or freeze may have won the insert. A fresh locked
  // read observes its committed row; never authorize using the proposed defaults.
  const [created] = await readLocked();
  return created;
}
