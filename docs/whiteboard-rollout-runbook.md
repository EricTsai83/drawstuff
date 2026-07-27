# Whiteboard V2 convergence and cutover runbook

## Scope and owners

Phase 5K converts every owned database document to canonical V2, lets the
existing 30-day retention policy exhaust encrypted legacy shared links,
converts local-only data during the support release, and then makes V2 the only
production read/write format.

The release owner controls deploys and the point-of-no-return approval. The
database owner owns snapshots, restore evidence, batch execution, and schema
constraints. The whiteboard owner investigates conversion differences. The
media owner verifies `file_record` and UploadThing content. The on-call engineer
owns abort and incident coordination.

## Hard readiness gate

Do not send an `apply` request until all of the following are attached to the
release record:

- A completed dry-run for every production database, ending with
  `hasMore: false`.
- Zero unsupported elements, unsupported fields, and missing or invalid
  referenced assets.
- A current database snapshot plus a separate UploadThing inventory, with a
  successful restore rehearsal using the matching pair.
- Seven days of zero missing-version or legacy writes after the Phase 5J
  release.
- Named owners, an incident channel, and a change window.

The maintenance endpoint enforces explicit acknowledgements for these items.
Those booleans are an operator guard, not a replacement for the release record.

## Inventory and dry-run

The endpoint is protected by `Authorization: Bearer $CRON_SECRET`. `GET`
returns the two cutover counters:

```sh
curl -sS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$BASE_URL/api/maintenance/whiteboard-convergence"
```

Scan owned scenes in ID order. Start without a cursor, then pass each
`nextCursor` until `hasMore` is false:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/maintenance/whiteboard-convergence" \
  --data '{"mode":"dry-run","batchSize":25,"abortAfterFailures":1}'
```

Each audit entry contains only a SHA-256 row identifier, before/after payload
hashes, a semantic hash, an asset-relationship hash, counts, source format, and
bounded error code. It never logs scene IDs, owners, names, URLs, document
content, asset bytes, or free-form errors.

`nextCursor` always advances past the last examined row, including a failed
row, so the inventory can finish. A response containing `retryFrom` means at
least one row in that window failed. Save that cursor with the failure audit,
finish the full scan, correct the data issue, and rerun from `retryFrom` until
that window is clean.

The dry-run fully decompresses and validates each payload. Referenced external
assets are fetched, content hashes are checked when present, file metadata is
validated, and the canonical output is parsed again. Draft rows with no payload
are inventoried and receive only version metadata during apply.

## Database conversion

Use batches of 25. Allow at most four requests per minute and only one active
request per database. A batch stops at the first failed row by default. Abort
the change window immediately for:

- any unsupported field or element;
- any missing, unreachable, mismatched, or corrupt referenced asset;
- more than three compare-and-swap conflicts across the full run;
- a database error rate above 1%, or latency above the agreed alert threshold;
- any unexplained change in counts, IDs, ownership, workspace/category
  relationships, publication metadata, or hashes.

Apply uses the same cursor loop and requires all readiness acknowledgements:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/maintenance/whiteboard-convergence" \
  --data '{
    "mode":"apply",
    "batchSize":25,
    "abortAfterFailures":1,
    "readiness":{
      "inventoryComplete":true,
      "snapshotCreated":true,
      "restoreTested":true,
      "zeroLegacyWrites":true
    }
  }'
```

The converter changes only `scene_data` and `document_version`. The update
matches row ID, revision, original payload, and original version, so a
concurrent edit becomes `conflict` and is never overwritten. Re-run conflicts
from the preceding cursor after the editor save completes. Revisions,
timestamps, ownership, workspaces, categories, publication state/slugs, and
file records are not updated.

## Encrypted shared links

Legacy `shared_scene` payloads cannot be converted server-side because their
AES key exists only in the URL fragment. Do not send that key to the server and
do not add an unauthenticated ciphertext-replacement endpoint.

Phase 5J already creates every new shared link as V2. Keep the existing 30-day
shared-link cleanup enabled for the full support window. It deletes expired
database rows and their remote files (or queues failed remote deletion).
Cutover is blocked until `legacySharedDocuments` is zero. Representative
retained V2 links must still open before and after the cleanup window.

## Local storage support release

On first load, the support release prefers a valid canonical document;
otherwise it converts the active legacy keys to V2. A conversion writes
`drawstuff-whiteboard-document`, reads and strictly parses the value back, and
compares its deterministic serialization. Obsolete keys are removed only after
their own inputs also validate. A failed write or verification leaves those
inputs in place and emits one aggregate migration failure per browser session.

Opening with `?recover=1` is intentionally isolated: the recovery snapshot is
converted in memory without replacing the canonical key or deleting either
copy. It becomes canonical, and the recovery key is consumed, only after the
user explicitly saves the recovered document.

Keep this release available for the documented support window. At its end,
approve explicitly that users who never opened the support release can lose
unsynchronized local-only legacy data. Phase 5L may then delete the temporary
converter and old key constants.

## Cutover order and point of no return

1. Finish database apply and a second full dry-run; require zero
   `would-convert` outcomes. The convergence/support deployment must run with
   `NEXT_PUBLIC_WHITEBOARD_V2_READ_CUTOVER=false`, so unconverted cloud and
   retained encrypted shared rows remain readable during this step.
2. Require `legacyDatabaseDocuments: 0` and `legacySharedDocuments: 0`.
3. Compare pre/post row counts, hashed IDs, owners, workspaces, categories,
   publication fields, revisions, timestamps, semantic hashes, file
   relationships, and asset content hashes.
4. Open representative local, cloud, shared, and published scenes; edit and
   save the writable cases.
5. Set `NEXT_PUBLIC_WHITEBOARD_V2_READ_CUTOVER=true` and deploy the V2-only
   readers. Verify that stale-client writes and legacy reads are rejected.
6. Run `pnpm db:push` to apply the required/current-version constraints only
   after both counters are zero. Existing and new drafts also carry version 2.
7. Run the repository checks and observe zero legacy/unsupported/missing-asset
   diagnostics for the final window.
8. The release owner and database owner record approval. This is the
   irreversible point of no return.

After step 8, handle defects with forward fixes. Operational snapshots follow
their separate retention policy and must never be mounted or exposed as
product documents.

## Rollback

Before the point of no return, stop new batches, deploy the paired pre-cutover
application, and restore the matching database snapshot and UploadThing
inventory. Validate counts and representative URLs before reopening writes.

Do not restore only the database or only the asset inventory, do not decrement
document versions, and do not overwrite rows that changed after the snapshot.
After point-of-no-return approval, do not re-enable legacy runtime reads; repair
affected V2 documents forward.
