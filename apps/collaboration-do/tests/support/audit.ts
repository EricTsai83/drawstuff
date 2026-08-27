/**
 * Config-audit contract between vitest.config.ts (which resolves
 * wrangler.jsonc with wrangler's own reader, Node side) and the workerd test
 * suite (which has no filesystem). The resolved snapshot travels into the
 * tests as a test-only JSON binding, so every field is strictly
 * JSON-representable (`null`, never `undefined`).
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type WranglerConfigAudit = {
  name: string | null;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
  workersDev: boolean | null;
  routes: JsonValue[];
  durableObjectBindings: {
    name: string;
    className: string;
    scriptName: string | null;
  }[];
  exports: Record<string, JsonValue>;
  legacyMigrations: JsonValue[];
  varKeys: string[];
  allowedOrigins: JsonValue | null;
  requiredSecrets: string[];
  cronTriggers: string[];
  versionMetadataBinding: string | null;
  observabilityEnabled: boolean;
};

/** Binding name the vitest config injects the audit snapshot under. */
export const WRANGLER_AUDIT_BINDING = "TEST_WRANGLER_CONFIG_AUDIT";

export type TestBindings = {
  [WRANGLER_AUDIT_BINDING]: WranglerConfigAudit;
};

/**
 * Test-fixture signing secret (32+ bytes). This is not a real credential —
 * real secrets exist only as Cloudflare secrets — it exists so token
 * verification paths can be exercised hermetically, mirroring the token
 * vectors in packages/collaboration.
 */
export const TEST_ROOM_TOKEN_SECRET =
  "drawstuff-collaboration-do-test-secret-0000000000000000";
