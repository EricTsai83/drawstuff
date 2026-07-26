import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    env: {
      SKIP_ENV_VALIDATION: "1",
    },
    unstubGlobals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
    server: {
      deps: {
        inline: [/@excalidraw/, "open-color"],
      },
    },
  },
});
