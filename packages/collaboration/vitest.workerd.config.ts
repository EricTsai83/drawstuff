import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * workerd correctness project (Plan 08): runs the shared Base64 codec vectors
 * and the fixed join/control token vectors inside the actual Workers runtime,
 * pinning the browser/Node/workerd wire contract independently of the Durable
 * Object suite. Deliberately separate from `vitest.config.ts` so the fast
 * inner loop stays workerd-free; run it with `pnpm test:workerd`.
 *
 * The compatibility date is pinned so a workerd upgrade is an explicit,
 * reviewable event rather than a silent behaviour change. `nodejs_compat` is
 * on because `./room-token` — the one server-only entry the Durable Object
 * imports directly — uses `node:crypto` HMAC by design (CLAIM-DO-6).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    name: "workerd",
    include: ["tests/workerd/**/*.test.ts"],
  },
});
