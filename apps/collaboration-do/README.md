# @drawstuff/collaboration-do

Cloudflare Worker gateway + `CollaborationRoom` Durable Object for the
collaboration relay migration. The Object runs the full Hibernatable-WebSocket
room runtime — join, membership, role
enforcement, opaque E2EE binary fanout, limits, backpressure, close
semantics, a single-alarm scheduler and the keepalive auto-response — wire
compatible with the Node relay, proven by a shared black-box conformance
suite both backends run
(`@drawstuff/collaboration/protocol-conformance`). Connection state lives in
per-socket attachments and SQLite only, so hibernation, eviction and code
updates recover everything. Single environment by design — a solo,
self-hosted project, deployed the same way `apps/web` is (main → the one
deployment). Long-term claims live in
[ADR-0002](../../docs/adr/0002-collaboration-durable-object-target.md) and
[ADR-0003](../../docs/adr/0003-collaboration-do-gateway-foundation.md); the
liveness/keepalive contract is documented in the
[collaboration SLO document](../../docs/performance/collaboration-slo-capacity.md) §9.

**The Worker carries 0% collaboration traffic until cutover (Plan 14)**,
guaranteed by two independent locks rather than by unreachability:

1. `COLLAB_ALLOWED_ORIGINS` lists only localhost — browsers on the real site
   fail the Origin check before any socket is forwarded (fail closed);
2. `collaborationRoom.join` still returns the Node relay URL — no client path
   points here until the PostgreSQL provider assignment flips (Plan 13/14).
   The traffic gate lives in the database, not in deploys.

## Public surface (fixed, versioned)

```text
GET  /healthz                                              readiness only, never touches a DO
GET  /v1/rooms/:roomId/generations/:authGeneration/socket  WebSocket upgrade only
POST /v1/control                                           Vercel backend only
```

## Commands

```bash
pnpm --filter @drawstuff/collaboration-do lint
pnpm --filter @drawstuff/collaboration-do typecheck
pnpm --filter @drawstuff/collaboration-do test        # runs inside workerd
pnpm --filter @drawstuff/collaboration-do knip
pnpm --filter @drawstuff/collaboration-do verify      # all four of the above
pnpm --filter @drawstuff/collaboration-do cf:typegen  # regenerate worker-configuration.d.ts

# Manual operations (the `db:push` analogs — human-triggered, evidence-producing):
pnpm --filter @drawstuff/collaboration-do preflight   # dry-run bundle+config, zero side effects
pnpm --filter @drawstuff/collaboration-do deploy      # verify → preflight → deploy
pnpm --filter @drawstuff/collaboration-do secret:put  # prompts for COLLAB_JOIN_TOKEN_SECRET

# Plan 12b measurement tooling (all target a deployed Worker in its 0%-traffic
# window; COLLAB_JOIN_TOKEN_SECRET must be the deployed Worker's secret):
pnpm --filter @drawstuff/collaboration-do conformance:remote <base-url>  # full shared conformance suite
pnpm --filter @drawstuff/collaboration-do loadtest <base-url> [flags]    # capacity/latency harness
pnpm --filter @drawstuff/collaboration-do smoke <url> # live gateway smoke, prints version id
```

`smoke` runs the closed-response HTTP checks with no credentials. When
`COLLAB_JOIN_TOKEN_SECRET` is set in the environment (the deployed Worker's
secret), it additionally runs the room-runtime smoke: two real WebSocket
clients join a fresh room through the deployed Worker, exchange E2EE-sealed
scene and presence frames (the room key never leaves the smoke process), and
verify the keepalive auto-response — deployed-worker evidence that is safe
during the 0%-traffic window.

Root shortcuts: `pnpm cf:deploy`, `pnpm cf:smoke <url>`.

Wrangler is never part of the root `dev` pipeline.

## Deployment

Reversible deploys are automated; irreversible state changes are manual (same
principle as the repo's `db:push` convention for Postgres schema).

| Change                                                   | How it deploys                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code-only (the everyday case)                            | auto: Workers Builds on push to `main`                                                                                                                                                                                |
| **First** deploy (creates the namespace)                 | the deliberate act of connecting Workers Builds in the Dashboard — that first build provisions the namespace, its build log is the evidence (zero CLI); `pnpm cf:deploy` from a `wrangler login`-ed machine works too |
| Later lifecycle changes (`exports` create/rename/delete) | manual only: `pnpm cf:deploy` (one-time `wrangler login` when the day comes)                                                                                                                                          |
| Secret                                                   | Dashboard → Settings → Variables and Secrets (or `pnpm --filter @drawstuff/collaboration-do secret:put`)                                                                                                              |

The config-audit test pins `exports`, so a lifecycle change cannot merge
without editing the test as well — that is the deliberate-review signal; ship
it manually, alone, per CLAIM-MIG-4.

Zero-CLI bootstrap, in this order — `secrets.required` makes the deploy
refuse to ship while the secret is missing, so the secret comes first:
connect Workers Builds (below; the first build will fail on the missing
secret, which is the guardrail working) → Worker → Settings → Variables and
Secrets → add `COLLAB_JOIN_TOKEN_SECRET` → Retry build → this build creates
the namespace → verify with `pnpm cf:smoke <workers.dev-url>` (a plain HTTP
probe, no credentials) or by opening `/healthz` in a browser (expect
`"ok": true`).

Workers Builds settings (Dashboard → Workers & Pages → connect
`EricTsai83/drawstuff`):

| Field                                | Value                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Project name                         | `drawstuff-collaboration-do` (must equal `name` in wrangler.jsonc)                                     |
| Root directory                       | `apps/collaboration-do`                                                                                |
| Build command                        | `pnpm install --frozen-lockfile --trust-lockfile`                                                      |
| Deploy command                       | `pnpm run deploy` (runs verify + preflight before deploying)                                           |
| Builds for non-production branches   | **off** — preview builds run `wrangler versions upload`, which fails fast on configs with `exports`    |
| Build watch paths (Settings → Build) | include `apps/collaboration-do/*`, `packages/collaboration/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |

With GitHub branch protection on `main` (PR + required CI checks), every
auto-deployed commit has passed the full repo CI, and the deploy command
re-runs this package's own checks besides.

## Environment facts

|                                                             | value                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker name                                                 | `drawstuff-collaboration-do`                                                                                                                                    |
| Public URL                                                  | workers.dev (daily smoke/testing surface during migration)                                                                                                      |
| Allowed origins (`COLLAB_ALLOWED_ORIGINS`, comma-separated) | `http://localhost:3000` until Plan 14 cutover                                                                                                                   |
| DO namespace                                                | `CollaborationRoom` (SQLite)                                                                                                                                    |
| Secret                                                      | `COLLAB_JOIN_TOKEN_SECRET` (same value the app signs join/control tokens with, ≥32 bytes; Cloudflare secret only — never in `vars`, git, logs or test fixtures) |

`tests/config-audit.test.ts` audits all of the above against the resolved
wrangler config on every test run.

Custom domains are deliberately not configured: the workers.dev URL serves
the migration window, and assigning a real domain happens with cutover
(Plans 13–14) as a routing change together with widening the Origin
allowlist.

## Deployment lifecycle (CLAIM-MIG-4)

Class lifecycle (create/rename/delete in `exports`) is not gradually
deployable and cannot be rolled back across; it always ships alone:

1. Set the secret first (`secrets.required` blocks any deploy without it),
   then the first successful deploy (Workers Builds or local script)
   provisions the namespace. Run `pnpm cf:smoke <workers.dev-url>` — it
   checks `/healthz` plus the closed-response contract and prints the
   version id.
2. Record as evidence: Worker version id (from the build log, deploy output
   or `/healthz`), compatibility date (`2026-08-01`), namespace/class/backend
   (`CollaborationRoom`, SQLite), and that the secret is set.
3. Never roll back to before a namespace existed. Rollback keeps the
   namespace; the traffic locks (Origin allowlist + DB provider assignment)
   are what hold traffic at 0%, independent of deploys.
4. Schema migrations are forward-only and re-entrant; class
   lifecycle changes always deploy separately from runtime/schema/routing
   changes, manually.
5. Code-only deploys keep `exports` identical and may auto-deploy from
   `main` (with `exports` present, `wrangler versions upload`/gradual
   deployment is unavailable — do not switch back to legacy `migrations` to
   obtain it). Only roll back to a known-good version after the latest
   lifecycle boundary that can read and write the current SQLite schema.
