import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Plan 08 snapshot-codec benchmark: the 4 MiB encode/decode evidence for
 * `docs/performance/collaboration-slo-capacity.md`, run against the
 * *production* codec (never a benchmark-only copy) in Node, Chromium, and
 * WebKit. Separate from `vitest.config.ts` so measurement never slows the
 * test inner loop; run it with `pnpm bench:base64`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "bench-node",
          environment: "node",
          include: ["bench/base64-performance.test.ts"],
          testTimeout: 300_000,
        },
      },
      {
        test: {
          name: "bench-browser",
          include: ["bench/base64-performance.test.ts"],
          testTimeout: 300_000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }, { browser: "webkit" }],
          },
        },
      },
    ],
  },
});
