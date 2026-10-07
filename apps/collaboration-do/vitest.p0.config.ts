import path from "node:path";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createPostgresAdapter } from "./tests/p0/postgres-adapter.ts";

export default defineConfig(async () => {
  const url = process.env.COLLAB_P0_DATABASE_URL;
  if (
    !url ||
    new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/drawstuff_p0"
  )
    throw new Error(
      "Run pnpm collab:p0 with its disposable PostgreSQL fixture",
    );
  const adapter = await createPostgresAdapter(url);
  let closed = false;
  return {
    plugins: [
      {
        name: "p0-postgres-lifetime",
        closeBundle: async () => {
          if (closed) return;
          closed = true;
          await adapter.close();
          const output = process.env.COLLAB_P0_REPORT;
          if (output && adapter.reports.length) {
            await writeFile(
              output,
              JSON.stringify(
                {
                  schemaVersion: 1,
                  commit: execFileSync("git", ["rev-parse", "HEAD"], {
                    encoding: "utf8",
                  }).trim(),
                  workingTree: "uncommitted P0 prototype",
                  runtime: {
                    node: process.version,
                    postgres: "17-alpine",
                    workerdCompatibility: "2026-08-01",
                    vitest: "4.1.11",
                    vitestPlugin: "1.0.0 with repository prototype-proxy patch",
                  },
                  scope:
                    "Local workerd + host service binding + real PostgreSQL; synthetic provider and fixed identities; no deployed latency or capacity claim",
                  generatedAt: new Date().toISOString(),
                  scenarios: adapter.reports,
                },
                null,
                2,
              ) + "\n",
            );
            console.log(`P0 load report: ${output}`);
          }
        },
      },
      cloudflareTest({
        main: path.join(import.meta.dirname, "tests/p0/worker.ts"),
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            P0_ROOM: { className: "StorageBarrierPrototype", useSQLite: true },
          },
          serviceBindings: { P0_ADAPTER: (request) => adapter.fetch(request) },
        },
      }),
    ],
    test: {
      name: "collaboration-p0",
      include: ["tests/p0/**/*.test.ts"],
      exclude: process.env.COLLAB_P0_REPORT ? [] : ["tests/p0/load.test.ts"],
      fileParallelism: false,
      testTimeout: 15_000,
    },
  };
});
