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
pnpm --filter @drawstuff/collaboration-do test        # runs inside workerd
pnpm --filter @drawstuff/collaboration-do knip
pnpm --filter @drawstuff/collaboration-do cf:typegen  # regenerate worker-configuration.d.ts
pnpm --filter @drawstuff/collaboration-do deploy:staging
pnpm --filter @drawstuff/collaboration-do deploy:production
```

Wrangler is never part of the root `dev` pipeline. Never run a bare
`wrangler deploy` (the top-level environment is for local dev and Vitest
only).

## Environments

| | staging | production |
| --- | --- | --- |
| Worker name | `drawstuff-collaboration-do-staging` | `drawstuff-collaboration-do-production` |
| Public URL | workers.dev (staging smoke) | none — no route, no workers.dev |
| Allowed origins (`COLLAB_ALLOWED_ORIGINS`, comma-separated) | `http://localhost:3000` | `""` (fail closed) |
| DO namespace | own `CollaborationRoom` (SQLite) | own `CollaborationRoom` (SQLite) |
| Secret | `COLLAB_JOIN_TOKEN_SECRET` | `COLLAB_JOIN_TOKEN_SECRET` |

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
wrangler secret put COLLAB_JOIN_TOKEN_SECRET --env staging
wrangler secret put COLLAB_JOIN_TOKEN_SECRET --env production
```

## Deployment lifecycle (CLAIM-MIG-4)

Class lifecycle (create/rename/delete in `exports`) is not gradually
deployable and cannot be rolled back across; it always ships alone:

1. Deploy staging first: `pnpm --filter @drawstuff/collaboration-do deploy:staging`,
   then smoke `GET /healthz` (expect `ok: true` once the secret is set) and
   one socket/control probe against the workers.dev URL.
2. Provision production with a lifecycle-only deploy:
   `pnpm --filter @drawstuff/collaboration-do deploy:production`. Confirm the
   namespace reconciliation in the deploy output. No traffic is routed.
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
