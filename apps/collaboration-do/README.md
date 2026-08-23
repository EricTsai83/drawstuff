# @drawstuff/collaboration-do

Cloudflare Worker gateway + `CollaborationRoom` Durable Object foundation for
the collaboration relay migration (Plan 09 → 15). **Production carries 0%
collaboration traffic**: `collaborationRoom.join` still returns the Node relay
URL, the production Worker has no route and no workers.dev URL, and its Origin
allowlist is empty. Long-term claims live in
[ADR-0002](../../docs/adr/0002-collaboration-durable-object-target.md) and
[ADR-0003](../../docs/adr/0003-collaboration-do-gateway-foundation.md).

## Public surface (fixed, versioned)

```text
GET  /healthz                                              readiness only, never touches a DO
GET  /v1/rooms/:roomId/generations/:authGeneration/socket  WebSocket upgrade only
POST /v1/control                                           Vercel backend only (501 until Plan 11)
```

## Commands

```bash
pnpm --filter @drawstuff/collaboration-do lint
pnpm --filter @drawstuff/collaboration-do typecheck
pnpm --filter @drawstuff/collaboration-do test          # runs inside workerd
pnpm --filter @drawstuff/collaboration-do knip
pnpm --filter @drawstuff/collaboration-do verify        # all four of the above
pnpm --filter @drawstuff/collaboration-do cf:typegen    # regenerate worker-configuration.d.ts

# Manual operations (the `db:push` analogs — human-triggered, evidence-producing):
pnpm --filter @drawstuff/collaboration-do preflight:staging     # dry-run bundle+config, zero side effects
pnpm --filter @drawstuff/collaboration-do preflight:production
pnpm --filter @drawstuff/collaboration-do deploy:staging        # verify → preflight → deploy
pnpm --filter @drawstuff/collaboration-do deploy:production     # verify → preflight → deploy
pnpm --filter @drawstuff/collaboration-do secret:put:staging    # prompts for COLLAB_JOIN_TOKEN_SECRET
pnpm --filter @drawstuff/collaboration-do secret:put:production
pnpm --filter @drawstuff/collaboration-do smoke <base-url>      # live gateway smoke, prints version id
```

Root shortcuts: `pnpm cf:deploy:staging`, `pnpm cf:deploy:production`,
`pnpm cf:smoke <base-url>`.

Wrangler is never part of the root `dev` pipeline. Never run a bare
`wrangler deploy` (the top-level environment is for local dev and Vitest
only).

## Deployment paths

Reversible deploys are automated; irreversible state changes are manual (same
principle as the repo's `db:push` convention).

|             | staging                                                           | production                                                                        |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Trigger     | auto: Workers Builds on push to `main`                            | manual: `deploy:production` from a `wrangler login`-ed machine                    |
| Why         | code-only iteration, no users                                     | class lifecycle changes are atomic, non-gradual, and cannot be rolled back across |
| Credentials | Cloudflare-side GitHub App — no Cloudflare token stored in GitHub | local wrangler OAuth                                                              |

Order matters: run the **first** `deploy:staging` manually — it creates the
staging namespace, which is itself a lifecycle change (Plan 09 P3). Connect
Workers Builds afterwards, so automation only ever performs code-only deploys.

Workers Builds settings for staging (Dashboard → Workers & Pages → connect
`EricTsai83/drawstuff`):

| Field                                | Value                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Project name                         | `drawstuff-collaboration-do-staging` (must equal the env's `name` in wrangler.jsonc)                   |
| Root directory                       | `apps/collaboration-do`                                                                                |
| Build command                        | `pnpm install --frozen-lockfile --trust-lockfile`                                                      |
| Deploy command                       | `pnpm run deploy:staging` (runs verify + preflight before deploying)                                   |
| Builds for non-production branches   | **off** — preview builds run `wrangler versions upload`, which fails fast on configs with `exports`    |
| Build watch paths (Settings → Build) | include `apps/collaboration-do/*`, `packages/collaboration/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |

Production deploys happen exactly as often as the lifecycle demands (twice for
Plan 09, then rare code-only updates after staging soak). Keeping them manual
is the deliberation gate; no CI approval machinery is needed until the cadence
increases.

## Environments

|                                                             | staging                              | production                              |
| ----------------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| Worker name                                                 | `drawstuff-collaboration-do-staging` | `drawstuff-collaboration-do-production` |
| Public URL                                                  | workers.dev (staging smoke)          | none — no route, no workers.dev         |
| Allowed origins (`COLLAB_ALLOWED_ORIGINS`, comma-separated) | `http://localhost:3000`              | `""` (fail closed)                      |
| DO namespace                                                | own `CollaborationRoom` (SQLite)     | own `CollaborationRoom` (SQLite)        |
| Secret                                                      | `COLLAB_JOIN_TOKEN_SECRET`           | `COLLAB_JOIN_TOKEN_SECRET`              |

Durable Object bindings, vars, `secrets.required` and `version_metadata` are
not inherited between Wrangler environments; each environment declares them in
full and `tests/config-audit.test.ts` audits every environment separately.

Custom domains are deliberately not configured yet: staging smoke uses the
workers.dev URL, production is unreachable. Assigning real domains happens
with provider coexistence/cutover (Plans 13–14) as a routing change.

## Secrets checklist

The only secret is `COLLAB_JOIN_TOKEN_SECRET` (same value the app signs
join/control tokens with, ≥32 bytes). Per environment, as a Cloudflare secret
only — never in `vars`, git, logs or test fixtures:

```bash
pnpm --filter @drawstuff/collaboration-do secret:put:staging
pnpm --filter @drawstuff/collaboration-do secret:put:production
```

## Deployment lifecycle (CLAIM-MIG-4)

Class lifecycle (create/rename/delete in `exports`) is not gradually
deployable and cannot be rolled back across; it always ships alone:

1. Deploy staging first (`deploy:staging`, or let Workers Builds do it on
   merge), set the secret, then run
   `pnpm --filter @drawstuff/collaboration-do smoke <staging-url>` — it checks
   `/healthz` plus the closed-response contract and prints the version id.
2. Provision production with a lifecycle-only deploy:
   `pnpm --filter @drawstuff/collaboration-do deploy:production` (never from
   CI, never on push — see Plan 09 P3). Confirm the namespace reconciliation
   in the deploy output. No traffic is routed.
3. Record as evidence: Worker version ids (from the deploy output or
   `/healthz` on staging), compatibility date (`2026-08-01`),
   namespace/class/backend (`CollaborationRoom`, SQLite, per-env namespace)
   and the secrets checklist state.
4. Never roll back to before a namespace existed. Rollback means traffic
   stays at 0% and the namespace stays.
5. Schema migrations (from Plan 11 on) are forward-only and re-entrant; class
   lifecycle changes always deploy separately from runtime/schema/routing
   changes.
6. Code-only deploys keep `exports` identical, soak on staging, then ship
   with a full `wrangler deploy --env production` (with `exports` present,
   `wrangler versions upload`/gradual deployment is unavailable — do not
   switch back to legacy `migrations` to obtain it). Only roll back to a
   known-good version after the latest lifecycle boundary that can read and
   write the current SQLite schema.
