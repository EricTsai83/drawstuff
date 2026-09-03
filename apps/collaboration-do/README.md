# @drawstuff/collaboration-do

Cloudflare Worker gateway + `CollaborationRoom` Durable Object — the sole
production collaboration backend. The Object runs the full
Hibernatable-WebSocket room runtime — join, membership, role
enforcement, opaque E2EE binary fanout, limits, backpressure, close
semantics, a single-alarm scheduler and the keepalive auto-response — pinned
by the black-box conformance suite
(`@drawstuff/collaboration/protocol-conformance`), which runs both inside
workerd and remotely against the deployed Worker. Connection state lives in
per-socket attachments and SQLite only, so hibernation, eviction and code
updates recover everything. Single environment by design — a solo,
self-hosted project, deployed the same way `apps/web` is (main → the one
deployment). Long-term claims live in
[ADR-0002](../../docs/adr/0002-collaboration-durable-object-target.md) and
[ADR-0003](../../docs/adr/0003-collaboration-do-gateway-foundation.md); the
liveness/keepalive contract is documented in the
[collaboration SLO document](../../docs/performance/collaboration-slo-capacity.md) §9.

The Worker carries production collaboration traffic through DO-only routing.
`COLLAB_ALLOWED_ORIGINS` admits the production web app and localhost
development; short-lived join tokens remain the authorization boundary.

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
pnpm --filter @drawstuff/collaboration-do test        # workerd suite + hermetic CLI harness smoke
pnpm --filter @drawstuff/collaboration-do test:harness # remote runner + short load via localhost
pnpm --filter @drawstuff/collaboration-do knip
pnpm --filter @drawstuff/collaboration-do verify      # all four of the above
pnpm --filter @drawstuff/collaboration-do cf:typegen  # regenerate worker-configuration.d.ts

# Manual operations (the `db:push` analogs — human-triggered, evidence-producing):
pnpm --filter @drawstuff/collaboration-do preflight   # dry-run bundle+config, zero side effects
pnpm --filter @drawstuff/collaboration-do deploy      # verify → preflight → deploy
pnpm --filter @drawstuff/collaboration-do secret:put  # prompts for COLLAB_JOIN_TOKEN_SECRET
pnpm --filter @drawstuff/collaboration-do secret:put:cron # prompts for COLLAB_CRON_SECRET
pnpm --filter @drawstuff/collaboration-do secret:put:drain-url # prompts for COLLAB_OUTBOX_DRAIN_URL
pnpm --filter @drawstuff/collaboration-do secret:list # lists secret names, never values
pnpm --filter @drawstuff/collaboration-do tail        # streams live Worker logs until stopped

# Deployed-worker verification tooling (run before the first production
# assignment; COLLAB_JOIN_TOKEN_SECRET must match the deployed Worker):
pnpm --filter @drawstuff/collaboration-do conformance:remote <base-url>  # full shared conformance suite
pnpm --filter @drawstuff/collaboration-do loadtest <base-url> [flags]    # diagnostic load harness
pnpm --filter @drawstuff/collaboration-do smoke <url> # live gateway smoke, prints version id
```

`smoke` runs the closed-response HTTP checks with no credentials. When
`COLLAB_JOIN_TOKEN_SECRET` is set in the environment (the deployed Worker's
secret), it additionally runs the room-runtime smoke: two real WebSocket
clients join a fresh room through the deployed Worker, exchange E2EE-sealed
scene and presence frames (the room key never leaves the smoke process), and
verify the keepalive auto-response.

`MAX_CONNECTIONS_PER_ROOM` remains an internal safety and abuse bound, not a
verified capacity promise. `loadtest` is available for targeted diagnosis when
real usage or platform metrics justify it; release qualification only requires
small-group fanout correctness, not an exhaustive member/cadence matrix.

Root shortcuts: `pnpm cf:typegen`, `pnpm cf:preflight`, `pnpm cf:deploy`,
`pnpm cf:smoke <url>`, `pnpm cf:conformance <url>`,
`pnpm cf:loadtest <url>`, `pnpm cf:secrets`, and `pnpm cf:tail`.

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

|                                                             | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker name                                                 | `drawstuff-collaboration-do`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Public URL                                                  | `https://drawstuff-collaboration-do.ericts.workers.dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Allowed origins (`COLLAB_ALLOWED_ORIGINS`, comma-separated) | `https://draw.ericts.com,http://localhost:3000`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DO namespace                                                | `CollaborationRoom` (SQLite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Secrets                                                     | `COLLAB_JOIN_TOKEN_SECRET` (same value the app signs join/control tokens with, ≥32 bytes); `COLLAB_CRON_SECRET` (same value as the web app's `COLLAB_OUTBOX_CRON_SECRET` — a dedicated secret whose only power is triggering the idempotent outbox drain, never the maintenance `CRON_SECRET`); `COLLAB_OUTBOX_DRAIN_URL` (`https://<web origin>/api/collaboration/control-outbox`; a secret so deploys never clobber it, not because it is sensitive). Cloudflare secrets only — never in `vars`, git, logs or test fixtures |
| Cron trigger                                                | `* * * * *` — pings the web app's control-outbox drain endpoint (`src/outbox-drain.ts`); the minute clock lives here because the Vercel deployment's Hobby-plan crons are daily-only                                                                                                                                                                                                                                                                                                                                          |

`tests/config-audit.test.ts` audits all of the above against the resolved
wrangler config on every test run.

Custom domains are deliberately not configured; the production app uses the
Worker's `workers.dev` URL directly.

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
   namespace; before direct cutover the localhost-only Origin allowlist is
   the traffic lock.
4. Schema migrations are forward-only and re-entrant; class
   lifecycle changes always deploy separately from runtime/schema/routing
   changes, manually.
5. Code-only deploys keep `exports` identical and may auto-deploy from
   `main` (with `exports` present, `wrangler versions upload`/gradual
   deployment is unavailable — do not switch back to legacy `migrations` to
   obtain it). Only roll back to a known-good version after the latest
   lifecycle boundary that can read and write the current SQLite schema.
