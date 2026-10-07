import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { validateAuthOrigins } from "./config/auth-origins.ts";

const parsedEnv = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
    UPLOADTHING_TOKEN: z.string(),
    POSTGRES_URL: z.string().url(),
    POSTGRES_URL_NON_POOLING: z.string().url(),
    BETTER_AUTH_SECRET: z.string(),
    BETTER_AUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string(),
    GOOGLE_CLIENT_SECRET: z.string(),
    CRON_SECRET: z.string().min(1),
    CLEANUP_OWNER_EMAIL: z.string().email(),
    /** Private Room-to-storage adapter capability; unset refuses every request. Separate from identity and Gateway secrets. */
    COLLAB_ADAPTER_SECRET: z.string().min(32).optional(),
    COLLAB_IDENTITY_SECRET: z.string().min(32).optional(),
    COLLAB_AUTHORITY_SECRET: z.string().min(32).optional(),
    /**
     * Public HTTP origin of the Durable Object gateway. One Worker serves both
     * the control endpoint and the room WebSocket, so the server derives the
     * `ws(s)://` socket origin from this value, composes a stable roomId-scoped
     * socket path and returns the resulting opaque URL to the client;
     * provider identity never enters client state.
     */
    COLLAB_CONTROL_URL: z.string().url(),
    /** Refuses formal identity/authority/content entries during an incident. Private admin Lifecycle remains available. */
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
    VERCEL_ENV: process.env.VERCEL_ENV,
    UPLOADTHING_TOKEN: process.env.UPLOADTHING_TOKEN,
    POSTGRES_URL: process.env.POSTGRES_URL,
    POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    CLEANUP_OWNER_EMAIL: process.env.CLEANUP_OWNER_EMAIL,
    COLLAB_ADAPTER_SECRET: process.env.COLLAB_ADAPTER_SECRET,
    COLLAB_IDENTITY_SECRET: process.env.COLLAB_IDENTITY_SECRET,
    COLLAB_AUTHORITY_SECRET: process.env.COLLAB_AUTHORITY_SECRET,
    COLLAB_CONTROL_URL: process.env.COLLAB_CONTROL_URL,
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

if (!process.env.SKIP_ENV_VALIDATION) {
  validateAuthOrigins({
    betterAuthUrl: parsedEnv.BETTER_AUTH_URL,
    publicBaseUrl: parsedEnv.NEXT_PUBLIC_BASE_URL,
    deploymentEnvironment: parsedEnv.VERCEL_ENV,
  });
}

export const env = parsedEnv;
