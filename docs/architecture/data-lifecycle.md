# Data lifecycle

- Status: Current
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

## Deferred object cleanup

PostgreSQL and object storage cannot share one transaction. Any operation that makes an object
orphaned therefore deletes the owning row and inserts its `ut_file_key` into
`deferred_file_cleanup` in the same database transaction. The queue is the durable outbox; object
deletion is retried independently and queue rows retain failure state.

Routine maintenance runs named jobs independently so one failure does not suppress later work. Jobs
that enqueue object cleanup run before the bounded queue drain. The route uses a non-pooled advisory
lock for single flight, an absolute deadline, per-job outcomes, and bounded work counts. Routine cron
does not include account purge.

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

Owner-scoped deletion is implemented. Cross-user scene, room, and account retirement through the
same cleanup paths is not yet implemented and is required before public testing; see
[operator data retirement](../../plans/operator-data-retirement.md). Direct SQL deletion is not an
acceptable substitute because it bypasses object cleanup, relay shutdown, and audit records.
