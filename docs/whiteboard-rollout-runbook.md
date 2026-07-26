# Whiteboard rollout and rollback runbook

## Ownership

| Responsibility                         | Owner                              | Escalation       |
| -------------------------------------- | ---------------------------------- | ---------------- |
| Rollout flag and deployment            | Release owner                      | Engineering lead |
| Migration, save, and recovery failures | Whiteboard owner                   | Database owner   |
| Asset and export failures              | Media owner                        | Whiteboard owner |
| Diagnostic dashboards and alerts       | On-call engineer                   | Release owner    |
| Rollback decision                      | Release owner and on-call engineer | Engineering lead |

The named people for each role must be recorded in the release ticket before a
production stage starts. A stage does not start while any role is unassigned.

## Server-controlled flags

| Variable                                  | Meaning                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `WHITEBOARD_ENGINE_ENABLED`               | Enables internal and percentage evaluation.                                                            |
| `WHITEBOARD_ENGINE_ROLLBACK`              | Routes every new editing session to Excalidraw. This has highest priority.                             |
| `WHITEBOARD_ENGINE_PERCENTAGE`            | Stable signed-in user cohort from `0` through `100`.                                                   |
| `WHITEBOARD_ENGINE_INTERNAL_EMAILS`       | Comma-separated internal email allowlist.                                                              |
| `WHITEBOARD_ENGINE_FORCE_OWNED_SUBJECTS`  | Comma-separated user IDs reserved for recovery. Use the internal email allowlist for ordinary testing. |
| `WHITEBOARD_ENGINE_FORCE_LEGACY_SUBJECTS` | Comma-separated user IDs for targeted rollback.                                                        |

Evaluation happens on the server. The selected engine is passed once to the
workspace layout and remains fixed for that editing session. Percentage
targeting hashes the stable user ID; anonymous sessions remain on the adapter.
Global rollback overrides every other target.

## Diagnostics

Search structured application logs for `whiteboard-diagnostic`. The accepted
dimensions are only:

- `operation`: `load`, `migration`, `save`, `asset`, `export`, or `render`
- `outcome`: `success`, `failure`, or `blocked`
- `engine`: `owned` or `excalidraw`
- numeric `documentVersion`
- a bounded `errorCode`

The endpoint rejects scene/user IDs, names, free-form errors, elements,
encrypted scene content, and asset data, and accepts only authenticated
sessions. Compare each rate by engine and document version over the same
window.

## Promotion thresholds

Every stage must satisfy all of these conditions throughout its monitoring
window:

- No confirmed data loss, destructive rewrite, or unrecoverable migrated scene.
- No critical load, save, rename, workspace, share, export, conflict, recovery,
  offline, or interrupted-save workflow failure.
- Owned `load`, `save`, `asset`, `export`, and `render` failure rate is below
  `1.0%` and no more than `0.25` percentage points above the adapter.
- Migration failure rate is below `0.5%`.
- Save conflicts are investigated separately and do not hide non-conflict save
  failures.
- The rollback exercise completes with the retained legacy payload unchanged
  and post-migration owned edits recoverable.

Any confirmed data loss, unsafe downgrade, critical workflow regression, or
threshold breach triggers rollback. A release owner may pause a stage for a
smaller anomaly without increasing the cohort.

## Stages

| Stage | Target                                   | Minimum window  | Required evidence                                                                  |
| ----- | ---------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| 0     | Automated fixtures and local development | One full CI run | Typecheck, lint, build, full tests, fixed legacy fixture comparison, rollback test |
| 1     | Internal users                           | 48 hours        | Desktop pointer/keyboard plus touch, pen, and mobile smoke matrix                  |
| 2     | Stable `5%` production cohort            | 72 hours        | Threshold dashboard and one production-shaped recovery exercise                    |
| 3a    | `25%`                                    | 72 hours        | Thresholds pass with adapter comparison                                            |
| 3b    | `50%`                                    | 72 hours        | Thresholds pass with adapter comparison                                            |
| 3c    | `100%` default-on                        | 7 days          | All critical workflows and supported layouts pass                                  |

Do not combine a cohort increase with unrelated dependency or schema changes.
Keep the Excalidraw adapter deployable through the complete default-on window.

## Compatibility matrix

Before every production increase, verify:

- Sources: local storage, database scene, encrypted shared link, and published
  viewer.
- Inputs: desktop pointer, touch, pen, keyboard shortcuts, and mobile layout.
- Workflows: load, edit, save, rename, move workspace, share, PNG/SVG/document
  export, optimistic conflict, recovery, offline editing, and interrupted save.
- Fixtures: shapes/text, images/binary files, large groups/viewport, and
  pre-migration bindings.

Automated coverage owns document parsing, fixed-scene geometry/assets,
local/database/shared/published loading, save conflicts, export, renderer, and
rollback invariants. The release ticket owns the device and offline smoke
evidence.

## Global rollback command

Run from an authenticated release workstation:

```bash
printf 'true\n' | pnpm dlx vercel env add WHITEBOARD_ENGINE_ROLLBACK production --force
pnpm dlx vercel --prod
```

Then open a new editing session and confirm its diagnostic engine is
`excalidraw`. Existing sessions remain on their original engine until reload;
notify active internal testers before the deployment.

For a targeted rollback, add the user ID to
`WHITEBOARD_ENGINE_FORCE_LEGACY_SUBJECTS` and redeploy. Never lower the
percentage as a substitute for an incident rollback because stable hashing
does not guarantee that a specific affected user leaves the cohort.

## Recovery after rollback

Owned sessions write only `whiteboard-v1`. Local documents retain the original
legacy payload byte-for-byte; cloud documents retain a versioned rollback copy
whose JSON is normalized and whose asset bytes are moved to owner-scoped file
records. Local legacy keys are not changed. Public and encrypted share payloads
remove the rollback envelope and inline asset bytes before delivery. The server
rejects an Excalidraw write over an owned database payload with
`UNSAFE_DOWNGRADE`.

To recover edits made after migration:

1. Keep global rollback enabled for the general population.
2. Add only the affected user ID to
   `WHITEBOARD_ENGINE_FORCE_OWNED_SUBJECTS`. If global rollback is active,
   perform recovery in a separate deployment/environment because global
   rollback intentionally wins.
3. Load the retained owned database payload. Locally, forced recovery first
   reads `drawstuff-whiteboard-recovery-document` (parked before a remigration)
   and then `drawstuff-whiteboard-document`, regardless of the legacy revision.
   The parked key is consumed only after its first successful owned local save,
   so an interrupted recovery remains retryable and a later rollback cycle can
   park a fresh snapshot.
4. Export an owned document recovery copy before making new edits.
5. Verify element count, image assets, name, viewport, and the latest expected
   edit with the owner.
6. Save through the owned engine, remove the temporary force target, and retain
   the recovery export with the incident record.

Do not convert the latest owned document back to legacy. The legacy copy is a
route back to the adapter for pre-migration content; the owned document is the
recovery source for post-migration edits.

## Production-shaped rollback exercise

Use a database scene containing text, grouped shapes, an image asset, and a
saved viewport:

1. Load the legacy scene in an owned-targeted session and make a uniquely
   identifiable edit.
2. Save, rename, share, export, and reload it.
3. Capture the owned and retained legacy payload hashes.
4. Apply targeted rollback and verify the retained legacy copy loads.
5. Confirm a legacy save over the owned database payload is blocked.
6. Re-enter through the recovery flow and verify the unique owned edit.
7. Confirm both payload hashes remain unchanged until an intentional owned
   save.

Attach the results and diagnostic window to the release ticket before cohort
promotion.
