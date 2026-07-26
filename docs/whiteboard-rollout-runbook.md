# Whiteboard recovery runbook

## Current runtime

Drawstuff has one production editor and renderer: the owned whiteboard engine.
The Phase 5H percentage, internal-user, and live adapter rollback flags were
removed with the Excalidraw runtime. Every new editing session reads supported
legacy inputs through the runtime-free importer and writes `whiteboard-v1`.

The release owner, whiteboard owner, database owner, media owner, and on-call
engineer remain responsible for deployment, data recovery, asset/export
failures, and diagnostics.

## Diagnostics

Search structured application logs for `whiteboard-diagnostic`. New events use
the `owned` engine and one of these bounded operations:

- `load`, `migration`, `save`, `asset`, `export`, or `render`
- `success`, `failure`, or `blocked`
- numeric `documentVersion`
- a bounded `errorCode`

The schema continues accepting the historical `excalidraw` engine value so old
telemetry can be queried across the migration window. The endpoint rejects
scene/user IDs, names, free-form errors, elements, encrypted scene content, and
asset data.

## Compatibility matrix

Before releasing a whiteboard change, verify:

- Sources: owned local storage, retained legacy local keys, database scene,
  encrypted shared link, and published viewer.
- Inputs: desktop pointer, touch, pen, keyboard shortcuts, and mobile layout.
- Workflows: load, edit, save, rename, move workspace, share, PNG/SVG/document
  export, optimistic conflict, recovery, offline editing, and interrupted save.
- Fixtures: shapes/text, images/binary files, large groups/viewport, and
  pre-migration bindings.

Automated coverage owns document parsing, fixed-scene geometry/assets,
local/database/shared/published loading, save conflicts, export, renderer, and
recovery invariants. The release ticket owns device and offline smoke evidence.

## Retained legacy data

The importer keeps supported `.excalidraw` documents readable without loading
the removed package. Local documents retain the legacy keys as a byte-for-byte
recovery copy; cloud migrations carry a versioned `legacyRollback` envelope
whose asset bytes are moved to owner-scoped file records. Public and encrypted
share payloads remove the rollback envelope and inline asset bytes before
delivery.

Do not rewrite or delete retained legacy keys as part of a recovery. Export an
owned `.drawstuff` document before editing recovered data.

## Recovering owned edits

1. Open the editor with `?recover=1`. This loads
   `drawstuff-whiteboard-recovery-document` when present, otherwise
   `drawstuff-whiteboard-document`.
2. Verify element count, image assets, name, viewport, and the latest expected
   edit with the owner.
3. Export a `.drawstuff` recovery copy.
4. Save through the owned engine. The parked recovery key is consumed only
   after the first successful owned local save, so an interrupted recovery
   remains retryable.
5. Keep the recovery export with the incident record.

Never convert the latest owned document back to a legacy payload.

## Rolling back the removal release

There is no runtime feature flag after Phase 5I. If the removal itself must be
rolled back, revert the Phase 5I code change as one unit, restore its
`package.json` and `pnpm-lock.yaml`, rebuild, and redeploy. Do not roll back or
rewrite stored owned documents. Use the recovery flow above for data created
after migration.
