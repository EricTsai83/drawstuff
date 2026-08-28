# Data lifecycle

- Status: Current
- Generalized patterns: [data lifecycle & GC](../system-design/data-lifecycle-and-gc.md),
  [transactional outbox](../system-design/transactional-outbox.md)
- Persistence boundary: [ADR 0001](../adr/0001-excalidraw-persistence-boundary.md)
- Operational conventions: [engineering conventions](../operations/engineering-conventions.md)

This document defines how user-scoped Library data, owned-scene assets, and room-scoped encrypted
data are retained and retired. Database rows and object-storage bytes are separate resources;
deletion must preserve their transaction boundary through the durable cleanup outbox.

## Lifecycle matrix

| Data                   | Identity                                         | Active retention                           | Retirement path                                                             |
| ---------------------- | ------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| Personal Library       | user id                                          | One optimistic-revision snapshot per user  | Account deletion cascades the PostgreSQL row                                |
| Owned-scene document   | scene id + document revision                     | Until owner deletion                       | Owner/admin scene deletion; relational cascade plus deferred object cleanup |
| Owned-scene asset      | scene id + `excalidraw_file_id`                  | While the committed document references it | Unreferenced-asset GC deletes the row and enqueues its storage key          |
| Collaboration snapshot | room id + auth generation                        | One optimistic-revision row per generation | Old generation retirement, room retention, or owner reset                   |
| Collaboration asset    | room id + auth generation + `excalidraw_file_id` | At most 512 per generation                 | Old generation or room retention deletes rows and enqueues storage keys     |
| Room metadata          | room id                                          | Active, ended, or within retention grace   | Expired active rooms become ended; the row remains as lifecycle history     |
| Shared scene (link)    | shared scene id (nanoid)                         | 30 days from creation                      | Bounded maintenance job deletes rows after handling their storage objects   |

## Personal Library

`personal_library` stores one complete upstream `{ libraryItems }` snapshot per authenticated user.
It is independent of scene, workspace, and collaboration-room identity, so switching scenes reads
the same Library while switching accounts clears engine memory before the next user's snapshot is
loaded. The user foreign key uses `ON DELETE CASCADE`; Library data has no object-storage resource or
deferred-cleanup work.

The snapshot uses the existing pako compression envelope and records a format version, compressed
byte length, SHA-256 checksum, optimistic revision, and timestamps. The request is bounded before
base64 decode, after decode, and after decompression. The server validates only the envelope and
basic item/element structure; the client crosses the adapter-owned upstream restore boundary before
placing items into the engine. Current approved bounds and fixture evidence are recorded in
[personal Library bounds](../performance/personal-library-bounds.md).

The backend row is the only durable source of truth. There is no IndexedDB mirror, offline queue,
Background Sync, binary asset storage, catalog metadata, source URL, or catalog ID. An official
Library URL is fetched only during installation; the resulting complete items are merged and saved,
and later loads do not contact the catalog. Anonymous users may use the native Library panel for the
current page session but receive no backend durability. If a save or revision check fails, current
in-memory items remain usable and the UI reports an unsaved/error state; closing the page can lose
those unsaved changes.

## Owned-scene assets

`file_record` maps native Excalidraw file identity to object storage. `content_hash` is only a
lookup/dedup hint; filename, storage key, and compressed upload hash are not identity.

Before committing an owned document, the save transaction verifies that every live image
`fileId` has a matching `file_record`. Missing bytes reject the save with an explicit retryable
asset-missing outcome, leaving the scene dirty so the client can upload and retry. This prevents a
document from committing references that have already been cleaned up.

Cleanup and save serialize on the scene row. Cleanup reads the committed document, determines which
records remain referenced, and deletes only unreferenced rows in the same transaction. The shared
`readReferencedSceneAssetIds` interpretation is used by save validation, failed-upload cleanup, and
garbage collection; an unreadable document means "retain all", not "references none".

The client asks which file IDs already exist and uploads only missing assets. Re-saving an unchanged
scene must not upload or delete asset objects. Storage-provider custom IDs are not trusted as unique
because the provider contract does not guarantee uniqueness.

Scene thumbnails are replaced compare-and-set: the update lands only while the scene still holds the
key the upload handler read (or none), so two interleaved uploads leave exactly one referenced key.
The losing key — the previous thumbnail on success, the fresh upload when the CAS misses — is deleted
or routed to the deferred-cleanup queue. Thumbnails have no GC sweep; the CAS is what prevents
orphans.

## Deferred object cleanup

PostgreSQL and object storage cannot share one transaction. Any operation that makes an object
orphaned therefore deletes the owning row and inserts its `ut_file_key` into
`deferred_file_cleanup` in the same database transaction. The queue is the durable outbox; object
deletion is retried independently and queue rows retain failure state.

The same transactional-outbox shape covers realtime enforcement: every collaboration room mutation
inserts its control intent into `collaboration_control_outbox` in the mutation's own transaction,
a minute-level schedule (the collaboration Worker's Cloudflare cron trigger pinging the web drain
endpoint) drains it to the room's Durable Object, and terminal rows (delivered after
7 days, poison-failed after 30) are purged by a bounded weekly retention job. Pending rows are
enforcement debt and are never purged. See the
[collaboration system design](./collaboration-system-design.md) for delivery semantics.

Scene deletion, workspace deletion, account retirement, and the single-tenant purge all follow this
shape: the deleting transaction collects every storage key its cascade will orphan — asset records,
scene thumbnails, and the assets of collaboration rooms bound to the deleted scenes or owned by the
deleted user — and inserts the keys into the outbox before the rows go. No deletion path calls
storage inline; deleting objects first would let a mid-loop crash leave live rows pointing at
missing objects, and deleting rows without enqueueing would strand objects the GC can never find
(it sweeps only scenes that still exist).

Collection locks every parent row (user, workspace, scene, shared scene, room) `FOR UPDATE` before
reading its keys. Writers that add keys either take the same lock (asset uploads lock the room row,
thumbnail replacement updates the scene row) or need the parent's `FOR KEY SHARE` for their foreign
key (file-record inserts), and both conflict with `FOR UPDATE` — so no key can land between
collection and the cascade that would orphan it. Outbox inserts are chunked so a many-thousand-object
account stays under the bind-parameter limit without leaving the transaction.

Routine maintenance runs named jobs independently so one failure does not suppress later work. Jobs
that enqueue object cleanup run before the bounded queue drain. The route uses a non-pooled advisory
lock for single flight, an absolute deadline, per-job outcomes, and bounded work counts. Routine cron
does not include account purge.

Every routine job is bounded per run; a backlog is worked through across runs instead of one
unbounded run starving the jobs queued behind it. Expired shared scenes (30-day retention) are
reclaimed oldest-first under scene/object caps and the route deadline, one transaction per scene in
the standard deletion shape: the shared-scene row is locked `FOR UPDATE` (serializing against
file-record inserts, which need its `FOR KEY SHARE`), its storage keys enter the cleanup outbox, and
the row is deleted — no inline storage call. The unreferenced-asset GC takes its bounded random
scene sample in SQL (`ORDER BY random() LIMIT n`) so the full candidate id set never enters memory.
Creating a shared scene is rate limited per user, and the public shared-scene read procedures per
client IP, on the same Upstash fail-open pipeline as the collaboration limits (key prefix
`drawstuff:shared-scene:ratelimit:v1`).

## Collaboration generation retirement

Snapshots and collaboration assets are scoped to an authorization generation. A successful write in
a newer generation removes older snapshot/asset rows. Asset storage keys enter the deferred-cleanup
outbox in the same transaction. Old-generation ciphertext is not kept as a fallback because the old
key represents revoked cryptographic authority.

Current-generation snapshot writes use optimistic revision checks and room-row authorization locks.
The snapshot row is deleted directly because its ciphertext is stored in PostgreSQL. The owner's
manual reset deletes only the current snapshot; it does not silently delete assets or room metadata.

## Ended and expired room retention

Routine retention uses a seven-day grace period:

- ended rooms count from `coalesce(ended_at, updated_at)`;
- active expired rooms count from `expires_at` and are changed to `ended` under the room lock before
  data removal, preventing a later create call from reviving an empty room;
- eligibility is rechecked after locking so a concurrent refresh cannot race with reclamation.

Each run is bounded by room count and asset-object count. A single schema-bounded room may consume
the first asset budget so it cannot starve forever; later rooms defer to another run. Snapshot rows
are deleted, asset rows are deleted and enqueued, and subsequent runs are idempotent. Live rooms and
rooms still inside the grace period are never reclaimed.

The routine maintenance queue drain is sized to cover the bounded producers in the same run and is
also constrained by wall-clock deadline. If the platform stops the process, the durable outbox keeps
remaining object work for the next run.

## Operator retirement

Cross-user scene, room, and account retirement uses the same lifecycle services as owner-scoped
deletion. Scene retirement deletes the scene row and enqueues every owned storage key in one
transaction; room termination advances authorization and pushes relay shutdown. Account retirement
collects every user-owned storage key, enqueues it, and cascade-deletes the Better Auth user row in
a single transaction — no per-scene or per-object round trips, so a large account cannot time out
half-retired — then pushes best-effort relay `end-room` control for rooms that were still active
(the deleted room row already guarantees no new join token can be signed). Direct SQL deletion is
not an acceptable substitute because it bypasses those guarantees.

Administrative authorization is DB-backed. Better Auth authenticates the caller, then
`adminProcedure` requires an active `operator` row in `admin_grant` keyed by the internal user ID.
Email is used only by the locked, first-admin bootstrap command to locate a verified Google-linked
account; it is never checked on normal requests. Bootstrap closes after the first active grant.

Each accepted administrative mutation first inserts a `started` row in `admin_audit_event`, then
marks it `succeeded` or `failed`. Audit rows deliberately have no foreign key to the actor or target,
so account retirement cannot erase the security record. Operational provisioning and invocation are
documented in [admin data retirement](../operations/admin-data-retirement.md).
