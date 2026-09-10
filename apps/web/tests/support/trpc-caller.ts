import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";

import type { TestDatabase } from "./pglite-db";

export type TestTRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

/**
 * A request context for `userId`, or an anonymous one for `null`. Only the
 * fields the routers read are present; the cast stands in for the request
 * plumbing a real `createTRPCContext` would have resolved.
 */
export function testTrpcContext(
  db: TestDatabase,
  userId: string | null,
): TestTRPCContext {
  return {
    db,
    headers: new Headers(),
    auth: userId
      ? { session: { id: `session-${userId}` }, user: { id: userId } }
      : null,
  } as unknown as TestTRPCContext;
}

/** A server-side router caller acting as `userId` (anonymous for `null`). */
export const testCaller = (db: TestDatabase, userId: string | null) =>
  createCaller(testTrpcContext(db, userId));
