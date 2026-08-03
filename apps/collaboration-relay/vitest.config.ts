import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests spawn real sockets and child processes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
