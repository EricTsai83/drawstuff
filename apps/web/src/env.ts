import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    UPLOADTHING_TOKEN: z.string(),
    POSTGRES_URL: z.string().url(),
    POSTGRES_URL_NON_POOLING: z.string().url(),
    POSTGRES_USER: z.string(),
    POSTGRES_HOST: z.string(),
    POSTGRES_PASSWORD: z.string(),
    POSTGRES_DATABASE: z.string(),
    POSTGRES_URL_NO_SSL: z.string().url(),
    POSTGRES_PRISMA_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string(),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string(),
    GOOGLE_CLIENT_SECRET: z.string(),
    CRON_SECRET: z.string().min(1),
    /**
     * Authorizes only `/api/collaboration/control-outbox`. Deliberately a
     * different secret from `CRON_SECRET`: this one is handed to Cloudflare
     * (the Worker cron trigger holds it as `COLLAB_CRON_SECRET`), and its
     * blast radius must stay "can trigger an idempotent outbox drain" — never
     * the maintenance route's user purge. Optional: unset means the drain
     * endpoint answers 401 to everything (fail closed) until it is
     * provisioned alongside the Worker.
     */
    COLLAB_OUTBOX_CRON_SECRET: z.string().min(1).optional(),
    CLEANUP_OWNER_EMAIL: z.string().email(),
    /**
     * HMAC secret shared with the collaboration Durable Object Worker
     * (apps/collaboration-do). Signs the short-lived room join tokens and the
     * server-to-server control tokens; required because the gateway has no
     * unauthenticated join path.
     */
    COLLAB_JOIN_TOKEN_SECRET: z.string().min(32),
    /** Public HTTP origin of the Durable Object gateway control endpoint. */
    COLLAB_CONTROL_URL: z.string().url(),
    /**
     * Public WebSocket origin of the Durable Object gateway. The server
     * composes a generation-scoped socket path and returns the resulting
     * opaque URL to the client; provider identity never enters client state.
     */
    COLLAB_RELAY_URL: z.string().url(),
    /**
     * Kill switch: refuse `collaborationRoom.create` and `join` entirely
     * with an explicit SERVICE_UNAVAILABLE. Existing sockets are untouched;
     * lifecycle mutations (leave/end/revoke) keep working so owners can
     * still shut rooms down. Same on-values as above.
     */
    COLLAB_ROOMS_DISABLED: z.string().optional(),
    /**
     * Upstash Redis REST credentials for the shared collaboration rate limits.
     * Server-side only and never `NEXT_PUBLIC_*`: the token is a full
     * read/write capability on the counter store.
     *
     * Validated here so a missing or malformed credential is a deployment
     * configuration error that fails at boot, rather than a request-time
     * degradation — the fail-open path exists for a Redis that is configured
     * and unreachable, not for one that was never configured.
     */
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
    NEXT_PUBLIC_BASE_URL: z.string().url(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    UPLOADTHING_TOKEN: process.env.UPLOADTHING_TOKEN,
    POSTGRES_URL: process.env.POSTGRES_URL,
    POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
    POSTGRES_USER: process.env.POSTGRES_USER,
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
    POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
    POSTGRES_URL_NO_SSL: process.env.POSTGRES_URL_NO_SSL,
    POSTGRES_PRISMA_URL: process.env.POSTGRES_PRISMA_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    COLLAB_OUTBOX_CRON_SECRET: process.env.COLLAB_OUTBOX_CRON_SECRET,
    CLEANUP_OWNER_EMAIL: process.env.CLEANUP_OWNER_EMAIL,
    COLLAB_JOIN_TOKEN_SECRET: process.env.COLLAB_JOIN_TOKEN_SECRET,
    COLLAB_CONTROL_URL: process.env.COLLAB_CONTROL_URL,
    COLLAB_RELAY_URL: process.env.COLLAB_RELAY_URL,
    COLLAB_ROOMS_DISABLED: process.env.COLLAB_ROOMS_DISABLED,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
