import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { WRANGLER_AUDIT_BINDING, type TestBindings } from "./support/audit.ts";

/**
 * Deployment-config audit (Plan 09, single environment): the lifecycle must
 * be the declarative SQLite `exports` (never legacy `migrations`), secrets
 * must never appear in `vars`, and until cutover (Plan 14) the Worker must
 * keep its two traffic locks — a localhost-only Origin allowlist here, and
 * `collaborationRoom.join` still returning the Node relay URL in apps/web.
 * The snapshot is resolved by wrangler's own config reader in
 * vitest.config.ts, so what is asserted is exactly what a deploy would ship.
 */
const audit = (env as unknown as TestBindings)[WRANGLER_AUDIT_BINDING];

describe("deployment config", () => {
  it("names the single Worker", () => {
    expect(audit.name).toBe("drawstuff-collaboration-do");
  });

  it("pins the verified compatibility date and nodejs_compat", () => {
    // Must match packages/collaboration/vitest.workerd.config.ts, where the
    // room-token vectors were proven on this exact runtime configuration.
    expect(audit.compatibilityDate).toBe("2026-08-01");
    expect(audit.compatibilityFlags).toContain("nodejs_compat");
  });

  it("declares the full SQLite-backed Durable Object configuration", () => {
    expect(audit.durableObjectBindings).toEqual([
      {
        name: "COLLABORATION_ROOM",
        className: "CollaborationRoom",
        // Same-bundle gateway + object (CLAIM-MIG-3): never a service/script
        // indirection.
        scriptName: null,
      },
    ]);
    // Pinning `exports` makes a lifecycle change (create/rename/delete)
    // impossible to slip into an auto-deploy: it cannot merge without also
    // editing this test, which is the deliberate-review signal CLAIM-MIG-4
    // requires. Lifecycle deploys themselves stay manual.
    expect(audit.exports).toMatchObject({
      CollaborationRoom: { type: "durable-object", storage: "sqlite" },
    });
    expect(Object.keys(audit.exports)).toEqual(["CollaborationRoom"]);
    // Legacy migrations would reintroduce gradual-rollout semantics the
    // claims forbid.
    expect(audit.legacyMigrations).toEqual([]);
  });

  it("keeps secrets out of vars and declares the required secret", () => {
    expect(audit.requiredSecrets).toEqual(["COLLAB_JOIN_TOKEN_SECRET"]);
    expect(audit.varKeys).toEqual(["COLLAB_ALLOWED_ORIGINS"]);
  });

  it("binds version metadata and enables Workers Logs", () => {
    expect(audit.versionMetadataBinding).toBe("VERSION_METADATA");
    expect(audit.observabilityEnabled).toBe(true);
  });

  it("keeps the pre-cutover traffic lock: localhost-only origins, no routes", () => {
    // Cutover (Plan 14) is the only change allowed to widen this allowlist
    // (to the real web origin) and to add routes/custom domains.
    expect(audit.allowedOrigins).toBe("http://localhost:3000");
    expect(audit.routes).toEqual([]);
    expect(audit.workersDev).toBe(true);
  });
});
