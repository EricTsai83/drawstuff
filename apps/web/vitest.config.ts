import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw", "open-color"],
      },
    },
    env: {
      SKIP_ENV_VALIDATION: "1",
      // Collaboration room tokens are signed with the real HMAC path in tests,
      // so the room-auth env has to be present (never a production secret).
      COLLAB_JOIN_TOKEN_SECRET: "web-test-room-token-secret-0123456789",
      COLLAB_CONTROL_URL: "http://127.0.0.1:3105",
      COLLAB_RELAY_URL: "ws://127.0.0.1:3105",
      // Present so the shared rate-limit module can build its module-scope
      // client at import time. Constructing the Upstash REST client opens no
      // connection; every test that exercises a limiter decision supplies its
      // own double rather than reaching this endpoint.
      UPSTASH_REDIS_REST_URL: "https://ratelimit.invalid",
      UPSTASH_REDIS_REST_TOKEN: "web-test-upstash-token",
    },
    unstubGlobals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
