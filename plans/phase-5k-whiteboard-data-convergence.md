# Phase 5K: Whiteboard Data Convergence and Cutover

## Goal

Convert every persisted document to canonical V2, prove that product data and
relationships remain consistent, and end the need for legacy runtime reads.

## Prerequisite

Phase 5J is merged and has produced zero legacy writes for the agreed
monitoring window.

## Readiness gate

Do not write production data until:

- A dry-run inventory covers every database, published, shared, and local
  storage boundary.
- The converter supports every live element and asset shape found by the audit.
- Unsupported live elements, unsupported fields, and missing assets are zero.
- Current database and asset snapshots exist and restoration has been tested.
- The runbook defines owners, batch size, rate limits, abort thresholds, and
  concurrent-edit handling.

## Database conversion

Run the one-time converter in bounded batches:

1. Read row ID, revision, payload, document version, and related assets.
2. Decode and validate the complete input without mutating it.
3. Convert V1 or Excalidraw input to canonical V2.
4. Validate the complete V2 output.
5. Compare semantic invariants and referenced assets.
6. Recompress the canonical payload.
7. Update through compare-and-swap so concurrent edits are never overwritten.
8. Record non-sensitive hashes and audit results outside product payloads.

Preserve:

- Scene and shared-scene IDs.
- User and workspace ownership.
- Categories and descriptive metadata.
- Publication state, slugs, and URLs.
- Revision semantics and timestamps except documented maintenance timestamps.
- Element and asset identities supported by the canonical model.
- File-record relationships and referenced content.

Published scenes must remain available at the same URLs after conversion.

## Shared links

Encrypted legacy shared links may not be convertible server-side when the key
exists only in the URL. Use a finite convergence path:

- Convert on access during the Phase 5K support window, or
- Wait for the existing retention period to expire and remove remaining legacy
  shared records.

Do not begin Phase 5L while any retained shared record needs a legacy parser.
Every new shared link is already V2 through Phase 5J.

## Local storage

Ship a time-bounded client release that:

- Converts the active local document to V2.
- Verifies the V2 write before deleting old keys.
- Removes obsolete revision markers and rollback snapshots.
- Records only aggregate success or failure.

After the documented support window, users who never ran the conversion release
may lose unsynchronized local-only legacy data. Treat that as an explicit
cutover decision rather than retaining legacy code indefinitely.

## Cutover

After all audits pass:

- Backfill every database document-version value.
- Make the version columns required and accept only the current write version.
- Block stale client builds.
- Stop production fallback reads.
- Declare the irreversible point of no return.
- Switch incident handling from application rollback to forward fixes.

Operational snapshots follow a separate retention policy and are never embedded
in or readable as product documents.

## Verification

- Re-run conversion in dry-run mode and require zero candidate rows.
- Compare pre/post counts, IDs, owners, workspaces, categories, publication
  metadata, revision semantics, content hashes, and asset references.
- Open representative local, cloud, shared, and published scenes.
- Verify normal read/write paths accept only V2.
- Verify legacy and unsupported counters remain zero for the final window.
- Run the required repository checks.

## Exit criteria

```text
legacy database documents = 0
legacy shared documents = 0
legacy local-storage reads = 0 for the agreed support window
legacy writes = 0
unsupported elements = 0
unsupported fields = 0
missing referenced assets = 0
```

- All database document-version values are current and required.
- Semantic consistency checks pass with no unexplained difference.
- The irreversible cutover is approved and recorded.
- Production no longer needs V1, Excalidraw, or migration fallback reads.

## Rollback

Before the point of no return, abort and restore the paired deployment,
database snapshot, and asset inventory when necessary. After approval, repair
defects forward instead of reintroducing legacy runtime paths.
