import { db } from "@/server/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { schema } from "@/server/db/schema";
import { env } from "@/env";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.NEXT_PUBLIC_BASE_URL],
  /**
   * Session policy stated here rather than inherited: a 7-day sliding session
   * that is refreshed at most once a day, and a 1-day "fresh" window for
   * operations that demand a recent sign-in. These equal the library's current
   * defaults on purpose — pinning them means a library upgrade cannot silently
   * change how long a sign-in lasts.
   */
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 60 * 24,
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  plugins: [nextCookies()], // make sure this is the last plugin in the array
});
