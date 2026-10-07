import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/postgres/*.integration.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
