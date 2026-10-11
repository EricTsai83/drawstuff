import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "@/server/db";
import { type auth } from "@/lib/auth";
import { getActiveOperatorGrant } from "@/server/admin/access";
import { rateLimitMetadataOf } from "@/server/rate-limit/collaboration";

type AuthObject = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * 1. CONTEXT — built per request by the API route handler and the RSC caller.
 */
export const createTRPCContext = async (opts: {
  headers: Headers;
  auth: AuthObject;
}) => {
  return {
    db,
    ...opts,
  };
};

/**
 * 2. INITIALIZATION — superjson transport; validation and rate-limit details
 * are surfaced in `error.data` for typed client handling.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
        /**
         * Machine-readable retry deadline for `TOO_MANY_REQUESTS`, and `null`
         * for every other error. A client must be able to decide "retry, but
         * not before this instant" without reading the human-readable message.
         */
        rateLimit: rateLimitMetadataOf(error.cause),
      },
    };
  },
});

/** Server-side caller (RSC and tests). */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE
 *
 * Routers in `src/server/api/routers` build on these three procedure tiers.
 */

export const createTRPCRouter = t.router;

/** No authentication; `ctx.auth` may be null. */
export const publicProcedure = t.procedure;

/** Requires a signed-in session and narrows `ctx.auth` to non-null. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.auth?.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { auth: ctx.auth } });
});

/** Signed-in user holding an active durable operator grant. */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const grant = await getActiveOperatorGrant(ctx.db, ctx.auth.user.id);
  if (!grant) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx: { adminGrant: grant } });
});
