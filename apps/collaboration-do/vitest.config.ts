import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";
import { z } from "zod";

import {
  TEST_ROOM_TOKEN_SECRET,
  WRANGLER_AUDIT_BINDING,
  type JsonValue,
  type WranglerConfigAudit,
} from "./tests/support/audit.ts";

/**
 * The whole suite runs inside workerd via the Cloudflare Vitest plugin, using
 * the same wrangler.jsonc a deploy uses (single environment: pinned
 * compatibility date + nodejs_compat), so the gateway and CollaborationRoom
 * are exercised in the actual runtime.
 *
 * The config audit resolves wrangler.jsonc here on the Node side — with
 * wrangler's own reader, exactly what a deploy would see — and ships the
 * snapshot into workerd as a test-only binding (tests have no filesystem).
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * The fields the audit reads from a resolved config. Validated at runtime
 * because wrangler's exported `Config` type does not resolve outside its own
 * package (it lives in the transitive @cloudflare/workers-utils).
 */
const resolvedEnvironmentSchema = z.looseObject({
  name: z.string().optional(),
  compatibility_date: z.string().optional(),
  compatibility_flags: z.array(z.string()).default([]),
  workers_dev: z.boolean().optional(),
  routes: z.array(jsonValueSchema).optional(),
  route: jsonValueSchema.optional(),
  durable_objects: z.object({
    bindings: z.array(
      z.looseObject({
        name: z.string(),
        class_name: z.string(),
        script_name: z.string().optional(),
      }),
    ),
  }),
  exports: z.record(z.string(), jsonValueSchema).default({}),
  migrations: z.array(jsonValueSchema).default([]),
  vars: z.record(z.string(), jsonValueSchema).optional(),
  secrets: z
    .looseObject({ required: z.array(z.string()).optional() })
    .optional(),
  triggers: z.looseObject({ crons: z.array(z.string()).optional() }).optional(),
  version_metadata: z.looseObject({ binding: z.string() }).optional(),
  observability: z.looseObject({ enabled: z.boolean().optional() }).optional(),
});

function auditConfig(): WranglerConfigAudit {
  const config = resolvedEnvironmentSchema.parse(
    unstable_readConfig(
      { config: path.join(import.meta.dirname, "wrangler.jsonc") },
      { hideWarnings: true },
    ),
  );
  // `undefined` cannot cross the JSON binding boundary, so absent config
  // values become `null` here and the tests assert on `null`.
  return {
    name: config.name ?? null,
    compatibilityDate: config.compatibility_date ?? null,
    compatibilityFlags: config.compatibility_flags,
    workersDev: config.workers_dev ?? null,
    routes: [
      ...(config.routes ?? []),
      ...(config.route === undefined ? [] : [config.route]),
    ],
    durableObjectBindings: config.durable_objects.bindings.map((binding) => ({
      name: binding.name,
      className: binding.class_name,
      scriptName: binding.script_name ?? null,
    })),
    exports: config.exports,
    legacyMigrations: config.migrations,
    varKeys: Object.keys(config.vars ?? {}),
    allowedOrigins: config.vars?.COLLAB_ALLOWED_ORIGINS ?? null,
    requiredSecrets: config.secrets?.required ?? [],
    cronTriggers: config.triggers?.crons ?? [],
    versionMetadataBinding: config.version_metadata?.binding ?? null,
    observabilityEnabled: config.observability?.enabled === true,
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          COLLAB_JOIN_TOKEN_SECRET: TEST_ROOM_TOKEN_SECRET,
          // Freeze only the rate-limit elapsed-time source. workerd can process
          // a queued frame flood below the production refill rate on a loaded
          // CI host, which is not an over-rate stream from the Object's point
          // of view. A fixed test clock makes burst exhaustion deterministic;
          // absolute token/room/alarm time continues to use real Date.now().
          TEST_RATE_LIMIT_NOW_MS: 1_000_000,
          [WRANGLER_AUDIT_BINDING]: auditConfig(),
        },
      },
    }),
  ],
  test: {
    name: "collaboration-do",
    include: ["tests/**/*.test.ts"],
  },
});
