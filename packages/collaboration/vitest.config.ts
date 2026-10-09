import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Two projects over the same sources.
 *
 * `node` runs everything, which is the fast inner loop. `browser` re-runs the
 * durable-format suites unchanged in real Chromium and WebKit, because Node's
 * host APIs are a different implementation: `crypto.subtle` digests,
 * `BufferSource` handling, `TextDecoder`, and `atob`/`btoa` are exactly the
 * surfaces where a browser could diverge, and the fixed test vectors are what
 * would catch it.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // Flat glob on purpose: `tests/workerd/` belongs to the separate
          // workerd project (`vitest.workerd.config.ts`, run via test:workerd).
          include: ["tests/*.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          // The codecs whose output is stored (snapshots and their SHA-256
          // checksum, asset payloads, base64) are the parts whose correctness
          // depends on host APIs; the rest is plain TypeScript already covered
          // by the node project. A browser divergence in a stored format would
          // corrupt data rather than one frame.
          include: [
            "tests/asset.test.ts",
            "tests/base64.test.ts",
            "tests/snapshot.test.ts",
          ],
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
