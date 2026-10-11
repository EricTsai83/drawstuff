# Data lifecycle

- Status: Current
- Generalized patterns: [data lifecycle & GC](../system-design/data-lifecycle-and-gc.md),
  [transactional outbox](../system-design/transactional-outbox.md)
- Persistence boundary: [ADR 0001](../adr/0001-excalidraw-persistence-boundary.md)
- Operational conventions: [engineering conventions](../operations/engineering-conventions.md)

This document defines how user-scoped Library data, owned-scene assets, and room-scoped
collaboration data are retained and retired. Database rows and object-storage bytes are separate resources;
deletion must preserve their transaction boundary through the durable cleanup outbox.

The collaboration schema includes nullable source scenes, initializing/ready/ended room metadata,
immutable operation results, pre-activation subject registration, lifecycle records, account- and
email-keyed list projections, and projection tombstones in PostgreSQL. Room content is stored in
plaintext (plan 21, deployed 2026-10-10). Retention reclaims only
explicitly ended rooms; ready/initializing rooms never expire. Linked-room FKs still cascade, while
NULL-source rooms are independent. Lifecycle terminal records survive account/scene deletion. All account/scene deletion callers use confirmed Lifecycle retirement before parent cascade. See the [authority contract](collaboration-authority.md).

## Lifecycle matrix

| Data                   | Identity                                         | Active retention                           | Retirement path                                                             |
| ---------------------- | ------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| Personal Library       | user id                                          | One optimistic-revision snapshot per user  | Account deletion cascades the PostgreSQL row                                |
| Owned-scene document   | scene id + document revision                     | Until owner deletion                       | Owner/admin scene deletion; relational cascade plus deferred object cleanup |
| Owned-scene asset      | scene id + `excalidraw_file_id`                  | While the committed document references it | Unreferenced-asset GC deletes the row and enqueues its storage key          |
| Collaboration snapshot | room id                                          | One optimistic-revision row per room       | Room-end cleanup, ended-room retention backstop, or owner reset             |
| Collaboration asset    | room id + `excalidraw_file_id`                   | At most 512 per room                       | Room-end cleanup or retention backstop deletes rows and enqueues storage keys |
| Room metadata          | room id                                          | While active; an ended room keeps only its row (empty label) and creation fence | Active rooms never expire; per-person rows of ended rooms are purged; the row goes 90 days after the end, the fence stays to refuse roomId reuse |
| Shared scene (link)    | shared scene id (nanoid)                         | 30 days from creation                      | Bounded maintenance job deletes rows after handling their storage objects   |
| Published render artifacts | scene id + variant (light/dark); content-hashed immutable object | While the scene is published; the pair is replaced on every save of the scene | Unpublish and scene/workspace/account deletion enqueue both keys; an uploaded pair nobody claims expires from its reservation into the same queue |

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

## Published render artifacts

A published scene additionally owns a light and a dark SVG rendered by the author's browser
(`render-published-artifacts.ts`) at publish time and after every later save; `/p/[slug]` serves
the pair instead of loading the engine ([render once, serve
many](../system-design/render-once-serve-many.md)). The scene row is the only pointer:
`published_svg_{light,dark}_{key,url}`, the engine version, the revision rendered from, and the
render time. A check constraint keeps the two keys paired.

Unlike assets, no row is written when an artifact object lands, and the two objects must take
effect together, so the upload handler cannot commit the pointer. Instead it *reserves* the key: a
`deferred_file_cleanup` row with reason `published-artifact-unclaimed` due one claim window (1 h)
later. `scene.publish` / `scene.setPublishedArtifacts` claim both reservations — delete the rows —
in the same transaction that writes the pointer, and refuse (without referencing the objects, and
without consuming a surviving reservation of a half-valid pair) when a reservation is missing or
due. The claim reads the pair `FOR UPDATE` and accepts only rows that stay undue for at least a
5-minute safety margin, taking its clock reading after the scene lock; the drain takes only due rows
with a non-locking read. The two can therefore overlap only if a claim transaction stays open across
the whole margin, so an artifact object is at every moment either referenced by exactly one scene
row or queued for deletion. A pair whose owner closed the tab
between upload and claim is therefore reclaimed by the routine drain with no special sweep.

Replacement runs under the scene row lock and is revision-guarded: artifacts rendered from an older
revision than the pair already stored are rejected as `stale` (two tabs saving), and the replaced
pair's keys enter the outbox in the same transaction. Unpublishing clears the pointer and enqueues
both keys; `collectSceneStorageKeys` includes both keys so scene, workspace and account deletion
follow the standard shape. A published row without a pair cannot arise through the API and is served
as not found rather than as an empty page; the public read returns only the artifact URLs — the scene
document and asset records never leave the owner's endpoints.

## Deferred object cleanup

PostgreSQL and object storage cannot share one transaction. Any operation that makes an object
orphaned therefore deletes the owning row and inserts its `ut_file_key` into
`deferred_file_cleanup` in the same database transaction. The queue is the durable outbox; object
deletion is retried independently and queue rows retain failure state. The drain runs in the weekly
maintenance cron: a failed deletion is retried after a fixed 1 h — so never twice in one drain, and
in practice on the next weekly run — and after 5 retries (about five weeks) the row becomes
`failed` and logs `cleanup.deferred_failed` (`error`, web server logs). The drain never picks up
`failed` rows again; operators review them in the admin console's **Failed file cleanup** section,
where retrying one or all (audited `retry-cleanup`) resets them to `pending` with zero attempts for
the next run. `done` rows are purged after 30 days; `failed` rows are kept until retried, because
each is the last pointer to an undeleted object.

Realtime enforcement uses the same outbox shape inside each Durable Object (`authority_work`), not a
PostgreSQL table; see the [collaboration authority](./collaboration-authority.md).

Scene deletion, workspace deletion, account retirement, and the single-tenant purge all follow this
shape: the deleting transaction collects every storage key its cascade will orphan — asset records,
scene thumbnails, published render artifacts, and the assets of collaboration rooms bound to the
deleted scenes or owned by the deleted user — and inserts the keys into the outbox before the rows go. No deletion path calls
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

## Room canvases and personal copies

Room content is never automatically written into the personal scene localStorage cache, for either
owners or guests, including after a copy upload. Before entry, only the prior personal canvas and
its identity/revision are preserved in per-tab sessionStorage. Leave restores that personal canvas
before enabling cache writers; sign-out clears the backup. A room reload uses an authorized
room baseline and cannot use personal cache as the room baseline. Unconfirmed room edits have
no offline/reload recovery guarantee.

An explicit personal copy captures the current canvas and uploads referenced files into the normal
personal asset lifecycle. It neither references room asset objects nor creates a source-room
cascade relation; deleting the room cannot reclaim the copy's attachments. Explicit original
updates use the preserved expected revision and update its separate backup only after success.
Destinations and confirmation semantics are defined in
[collaboration storage](./collaboration-storage.md).

## Collaboration snapshots

Each room has one snapshot row of plaintext `encodeCollaborationSnapshot` bytes with a checksum.
Writes use optimistic revision checks, the current authority epoch and room-row locks. The owner's
manual reset deletes only the current snapshot and keeps the revision watermark; it does not
silently delete assets or room metadata.

## Ended room retention

When a room ends, the Room DO's cleanup deletes its snapshot and asset rows (asset storage keys enter
the deferred-cleanup outbox in the same transaction) and purges per-person data: member and invite
projections, projection tombstones, operation receipts and lifecycle registrations; the room label
is cleared. Only the room row (`status='ended'`) and `collaboration_creation_fence` remain, so a
roomId can never be reused. Projection self-cleaning and the retention backstop apply the same purge
regardless of arrival order. Registration, parent creation, storage fences, cleanup and purges
serialize on a per-roomId advisory lock (order: account/scene → roomId lock → room row).

The routine `collab-room-retention` job is the backstop for anything the cleanup did not reach:

- a room qualifies when `status` or `storage_state` is ended, seven days after `coalesce(ended_at,
  updated_at)`, and only while it still holds data or a label;
- eligibility is rechecked after locking so a concurrent write cannot race with reclamation.

Each run is bounded by room count and asset-object count. A single schema-bounded room may consume
the first asset budget so it cannot starve forever; later rooms defer to another run. Subsequent
runs are idempotent. Live rooms and rooms still inside the grace period are never reclaimed.

The routine maintenance queue drain is sized to cover the bounded producers in the same run and is
also constrained by wall-clock deadline. If the platform stops the process, the durable outbox keeps
remaining object work for the next run.

The Room DO itself deletes all of its storage once an ended room's fence and cleanup are delivered
(or abandoned after 24 hours) and no connection remains; completed Lifecycle retirement objects
release their storage one hour after completion.

## Record retention

The weekly `record-retention` job (`apps/web/src/server/maintenance/jobs.ts`) deletes bookkeeping
rows nothing reads any more, at most 5,000 per kind per run, so no table grows for the life of the
deployment:

| Rows | Deleted when | Why it is safe |
| --- | --- | --- |
| `admin_audit_event` | older than 365 days | audit has no other retention requirement |
| `collaboration_operation` | terminal over 24 h | receipts only replay within `resultRetentionMs`; pending rows stay |
| `collaboration_lifecycle_subject` | account/scene row gone, and unfrozen or retired over 30 days ago | identity and registration also require the user/scene row; frozen, unretired subjects (retirements in flight) are never deleted |
| `collaboration_room` (ended) | storage fenced, data reclaimed, ended over 90 days ago | the creation fence stays and alone refuses the roomId |
| revoked `collaboration_room_member` / `collaboration_room_invite` | revoked over 30 days ago | late projection events cannot outlive the Room's 24 h abandonment |

`collaboration_creation_fence` rows (one tiny row per room ever created) are deliberately kept
forever: the Room DO keeps no tombstone after release, so the fence is the only thing that stops a
known ended roomId from being re-created.

## Operator retirement

Cross-user scene, room, and account retirement uses the same lifecycle services as owner-scoped
deletion. Scene retirement deletes the scene row and enqueues every owned storage key in one
transaction; room termination goes through the Lifecycle gateway `end-room`, which ends the Room DO
and closes its sockets. Account and scene retirement first complete durable Lifecycle retirement
(freeze, end or revoke affected rooms, confirm storage fences), then collect every owned storage
key, enqueue it, and cascade-delete the parent row in a single transaction — no per-scene or
per-object round trips, so a large account cannot time out half-retired. Direct SQL deletion is
not an acceptable substitute because it bypasses those guarantees.

Administrative authorization is DB-backed. Better Auth authenticates the caller, then
`adminProcedure` requires an active `operator` row in `admin_grant` keyed by the internal user ID.
Email is used only by the locked, first-admin bootstrap command to locate a verified Google-linked
account; it is never checked on normal requests. Bootstrap closes after the first active grant.

Each accepted administrative mutation first inserts a `started` row in `admin_audit_event`, then
marks it `succeeded` or `failed`. Audit rows deliberately have no foreign key to the actor or target,
so account retirement cannot erase the security record. Operational provisioning and invocation are
documented in [admin data retirement](../operations/admin-data-retirement.md).
