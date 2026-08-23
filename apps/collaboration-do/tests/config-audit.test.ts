import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  WRANGLER_AUDIT_BINDING,
  type TestBindings,
  type WranglerEnvironmentAudit,
} from "./support/audit.ts";

/**
 * Staging/production config audit (Plan 09): every environment must carry its
 * own complete Durable Object configuration (bindings are not inherited),
 * lifecycle must be the declarative SQLite `exports` (never legacy
 * `migrations`), and no name, namespace or secret may cross environments.
 * The snapshots are resolved by wrangler's own config reader in
 * vitest.config.ts, so inheritance behaves exactly as a deploy would see it.
 */
const audit = (env as unknown as TestBindings)[WRANGLER_AUDIT_BINDING];

const environments: [string, WranglerEnvironmentAudit][] = [
  ["top-level", audit.topLevel],
  ["staging", audit.staging],
  ["production", audit.production],
];

describe.each(environments)("%s environment", (_label, environment) => {
  it("pins the verified compatibility date and nodejs_compat", () => {
    // Must match packages/collaboration/vitest.workerd.config.ts, where the
    // room-token vectors were proven on this exact runtime configuration.
    expect(environment.compatibilityDate).toBe("2026-08-01");
    expect(environment.compatibilityFlags).toContain("nodejs_compat");
  });

  it("declares the full SQLite-backed Durable Object configuration", () => {
    expect(environment.durableObjectBindings).toEqual([
      {
        name: "COLLABORATION_ROOM",
        className: "CollaborationRoom",
        // Same-bundle gateway + object (CLAIM-MIG-3): never a service/script
        // indirection.
        scriptName: null,
      },
    ]);
    expect(environment.exports).toMatchObject({
      CollaborationRoom: { type: "durable-object", storage: "sqlite" },
    });
    // `exports` is the only lifecycle mechanism; legacy migrations would
    // reintroduce gradual-rollout semantics the claims forbid.
    expect(environment.legacyMigrations).toEqual([]);
  });

  it("keeps secrets out of vars and declares the required secret", () => {
    expect(environment.requiredSecrets).toEqual(["COLLAB_JOIN_TOKEN_SECRET"]);
    expect(environment.varKeys).toEqual(["COLLAB_ALLOWED_ORIGINS"]);
  });

  it("binds version metadata and enables Workers Logs", () => {
    expect(environment.versionMetadataBinding).toBe("VERSION_METADATA");
    expect(environment.observabilityEnabled).toBe(true);
  });
});

describe("environment isolation", () => {
  it("gives every environment its own Worker name (and thus namespace)", () => {
    expect(audit.topLevel.name).toBe("drawstuff-collaboration-do-dev");
    expect(audit.staging.name).toBe("drawstuff-collaboration-do-staging");
    expect(audit.production.name).toBe("drawstuff-collaboration-do-production");
  });

  it("keeps production publicly unreachable (0% traffic)", () => {
    expect(audit.production.workersDev).toBe(false);
    expect(audit.production.routes).toEqual([]);
    // Empty allowlist: even a future route fails closed at the Origin check
    // until cutover configures the real web origin.
    expect(audit.production.allowedOrigins).toBe("");
  });

  it("exposes staging only through its own workers.dev surface", () => {
    expect(audit.staging.workersDev).toBe(true);
    expect(audit.staging.routes).toEqual([]);
    expect(audit.staging.allowedOrigins).toBe("http://localhost:3000");
  });
});
