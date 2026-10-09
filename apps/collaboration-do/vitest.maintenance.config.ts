import path from "node:path";
import assert from "node:assert/strict";
import { unstable_readConfig } from "wrangler";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { z } from "zod";

// Wrangler's exported Config declaration includes unresolved transitive types.
// Validate its boundary instead of treating those values as typed configuration.
const configSchema = z.looseObject({
  name: z.string(),
  main: z.string().optional(),
  configPath: z.string().optional(),
  userConfigPath: z.string().optional(),
  exports: z.record(
    z.string(),
    z.object({
      type: z.literal("durable-object"),
      storage: z.literal("sqlite"),
    }),
  ),
  durable_objects: z.object({
    bindings: z.array(z.object({ name: z.string(), class_name: z.string() })),
  }),
  triggers: z.object({ crons: z.array(z.string()) }),
});
const readConfig = (config: string) =>
  configSchema.parse(
    unstable_readConfig(
      { config: path.join(import.meta.dirname, config) },
      { hideWarnings: true },
    ),
  );
const maintenance = readConfig("wrangler.maintenance.jsonc");
const bootstrap = readConfig("wrangler.bootstrap.jsonc");
const runtime = readConfig("wrangler.jsonc");
assert.equal(maintenance.name, runtime.name);
assert.equal(maintenance.main, bootstrap.main);
assert.deepEqual(maintenance.exports, {
  CollaborationRoom: runtime.exports?.CollaborationRoom,
});
assert.deepEqual(bootstrap.exports, runtime.exports);
assert.deepEqual(bootstrap.durable_objects, runtime.durable_objects);
assert.deepEqual(maintenance.triggers.crons, []);
// Only namespace declarations differ: the closed runtime is identical.
assert.deepEqual(
  {
    ...maintenance,
    exports: bootstrap.exports,
    durable_objects: bootstrap.durable_objects,
    configPath: bootstrap.configPath,
    userConfigPath: bootstrap.userConfigPath,
  },
  bootstrap,
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: path.join(import.meta.dirname, "tests/cutover/worker.ts"),
      miniflare: {
        bindings: {
          COLLAB_AUTHORITY_SECRET: "test-authority-secret-purpose-only-0001",
          COLLAB_ROOM_KEY_WRAP_SECRET:
            "test-key-wrap-secret-purpose-only-000001",
        },
      },
      wrangler: { configPath: "./wrangler.bootstrap.jsonc" },
    }),
  ],
  test: {
    name: "cutover-maintenance",
    include: ["tests/cutover/**/*.test.ts"],
  },
});
