import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Two projects over the same sources.
 *
 * `node` runs everything, which is the fast inner loop. `browser` re-runs the
 * crypto suite unchanged in real Chromium and WebKit, because Node's Web Crypto
 * is a different implementation: `crypto.subtle`, `BufferSource` handling, and
 * `atob`/`btoa` are exactly the surfaces where a browser could diverge, and the
 * fixed test vectors are what would catch it. Plan 14 requires that coverage.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          // The end-to-end codecs are the only parts whose correctness depends
          // on the host's Web Crypto; the rest is plain TypeScript already
          // covered by the node project. Durable snapshots seal under the same
          // primitives (AES-GCM, HKDF, SHA-256, base64) and are stored, so a
          // browser divergence there would corrupt data rather than one frame.
          include: [
            "tests/asset.test.ts",
            "tests/realtime-crypto.test.ts",
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
