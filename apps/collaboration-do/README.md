# Collaboration Worker

Protocol 7: plain (not end-to-end encrypted) rooms with Google Docs-style access. Stable `roomId` routes, SQLite Room authority (owner, invitation list, general access), identity proofs and private storage/Lifecycle capabilities. Rooms are protected by sign-in and access rules like owned scenes; only share links are end-to-end encrypted, and they do not touch this Worker. The plan 21 deploy (new Room class, data wipe) is a manual procedure: see [the deployment runbook §6](../../docs/operations/collaboration-do-deployment.md).

Room Durable Objects (`CollaborationRoomV2`) hold the access rules, operation receipts and bounded durable work; the role is computed on every check and never stored with a join. Snapshot bytes stream through the Worker to the web adapter; complete canvas bodies are never stored in DO SQLite. Durable work that stays undelivered for 24 hours is abandoned (`authority.work_abandoned`), and an ended, settled room deletes all of its storage (`room.storage_released`). Lifecycle Objects freeze a subject, enumerate conservative preregistrations, obtain every Room storage-fence acknowledgment and then request DB deletion; their work is never abandoned, and a completed retirement releases its storage one hour later. Durable alarms retry without the original caller. There is no scheduled cron.

Public surfaces: `/healthz`, `GET /v1/rooms/:roomId/socket` (identity proof in the join frame), and capability-protected `/v1/authority`, `/v1/snapshot`, `/v1/assets`, `/v1/lifecycle`. Nothing else resolves.

## Configuration

`wrangler.jsonc` pins the compatibility date, `nodejs_compat`, SQLite class exports, production origins, metadata and observability. `exports` declares `CollaborationRoomV2`, `CollaborationLifecycle`, and a `CollaborationRoom` tombstone (`state: "deleted"`) that removes the old encrypted rooms. Class lifecycle changes are manual: never roll back across them.

Provision purpose-separated `COLLAB_IDENTITY_SECRET`, `COLLAB_AUTHORITY_SECRET`, `COLLAB_ADAPTER_SECRET` (each at least 32 characters), plus Worker-only `COLLAB_ADAPTER_URL=https://<web-origin>/api/internal/collaboration/adapter` (`secret:put`, `secret:put:authority`, `secret:put:adapter`, `secret:put:adapter-url`). The matching web secrets authenticate identity issuance, service Gateway calls and adapter requests respectively. Secrets belong in Cloudflare secrets or private environment files, never `vars` or git.

```sh
pnpm --filter @drawstuff/collaboration-do verify
pnpm --filter @drawstuff/collaboration-do test:harness
pnpm cf:typegen
pnpm cf:preflight
pnpm cf:secrets
```

`test:harness` starts an ephemeral, isolated workerd with the actual production Gateway/Room/Lifecycle classes and a test-only adapter. It verifies maximum plain snapshot write/read, attachment descriptor finalization, ready, formal WebSocket, closure when general access is narrowed, end room and account retirement. The fixture entrypoint is never imported by production. Multi-connection SQL races use `pnpm collab:adapters`.

Remote `cf:smoke` / `cf:conformance` run the protocol-7 product harness against a deployed Worker using two existing verified test principals. `cf:loadtest` gathers 30 maximum-snapshot read samples; it is not a full live fanout qualification. Remote tools create/end Rooms and preserve accounts; UploadThing live provider acceptance (`pnpm collab:assets:remote`) is a separate gate.
