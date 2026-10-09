# Collaboration Worker

Source uses protocol 6: stable `roomId` routes, SQLite Room authority, identity proofs and private storage/Lifecycle capabilities. Production remains protocol 5 until the coordinated [18B P3 reset](../../docs/deployment/collaboration-reset/README.md). Do not push or deploy this artifact independently.

Room Durable Objects persist authorization, operation receipts and bounded metadata work. Snapshot ciphertext streams through the Worker; complete canvas bodies are never stored in DO SQLite. Lifecycle Objects freeze a subject, enumerate conservative preregistrations, obtain every Room storage-fence acknowledgment and then request DB deletion. Durable alarms retry without the original caller. There is no scheduled cron or control-outbox drain.

Public surfaces: `/healthz`, stable `/v1/rooms/:roomId/socket`, and capability-protected `/v1/authority`, `/v1/snapshot`, `/v1/assets`, `/v1/lifecycle`. The old `/v1/control` and generation socket paths return 404. Legacy internal runtime RPC remains private for regression coverage; no product writer routes to it.

## Configuration

`wrangler.jsonc` pins the compatibility date, `nodejs_compat`, SQLite class exports, production origins, metadata and observability. Class lifecycle changes are manual: never roll back across namespace creation. Keep the existing Room namespace while isolating/cleaning its old generation-named objects; Lifecycle uses its own declared class export.

Provision purpose-separated `COLLAB_IDENTITY_SECRET`, `COLLAB_AUTHORITY_SECRET`, `COLLAB_ADAPTER_SECRET` (each at least 32 characters), plus Worker-only `COLLAB_ADAPTER_URL=https://<web-origin>/api/internal/collaboration/adapter`. The matching web secrets authenticate identity issuance, service Gateway calls and adapter requests respectively. Plan 19 adds Worker-only `COLLAB_ROOM_KEY_WRAP_SECRET` (at least 32 random bytes; `pnpm --filter @drawstuff/collaboration-do secret:put:room-key-wrap`), which wraps Room's custody copy of each room key; set it before deploying, because `secrets.required` blocks the deploy without it. The private legacy regression path still has `COLLAB_JOIN_TOKEN_SECRET`; the protocol-6 public surface never accepts its role-bearing tokens. Secrets belong in Cloudflare secrets or private environment files, never `vars` or git.

```sh
pnpm --filter @drawstuff/collaboration-do verify
pnpm --filter @drawstuff/collaboration-do test:harness
pnpm cf:typegen
pnpm cf:preflight
pnpm cf:secrets
```

`test:harness` starts an ephemeral, isolated workerd with the actual production Gateway/Room/Lifecycle classes and a test-only adapter. It verifies maximum encrypted snapshot write/read/decryption, attachment descriptor finalization, ready, formal WebSocket, revoke/closure and account retirement. The fixture entrypoint is never imported by production. Multi-connection SQL races and reset/rollback use `pnpm collab:adapters`.

Remote `cf:smoke` / `cf:conformance` exercise the protocol-6 product path using two existing verified test principals. `cf:loadtest` gathers 30 maximum-snapshot read samples; it is not a full live fanout qualification. Inputs, maintenance isolation and the remaining deployed gates are documented in the P3 runbook. Remote tools create/end Rooms and preserve accounts; UploadThing live provider acceptance remains a separate gate.
