# Phase 5H: Whiteboard Migration and Rollout

## Goal

Introduce the owned editor to production gradually, measure compatibility, and
retain a tested route back to the Excalidraw adapter.

## Prerequisite

Phases 5A through 5G are merged and independently verified.

## Feature flags

- Select the engine through a server-controlled feature flag.
- Support internal-user, percentage, and explicit rollback targeting.
- Keep flag evaluation stable for an editing session.
- Record engine and document versions with diagnostics.
- Avoid exposing encrypted scene content or asset data in telemetry.

## Dual-format transition

- Read both legacy and owned documents.
- Write only the owned format for enabled sessions.
- Retain the original legacy payload or versioned rollback copy.
- Detect and block unsafe downgrade writes.
- Define how edits made after migration are recovered during rollback.

## Compatibility validation

- Compare Excalidraw and owned rendering with fixed scene fixtures.
- Test local, database, shared, and published scenes.
- Test desktop pointer, touch, pen, keyboard, and mobile layouts.
- Exercise load, save, rename, workspace, share, export, conflict, and recovery
  workflows.
- Test offline and interrupted-save behavior.

## Observability and rollout stages

Track load, migration, save, asset, export, and render failures by engine and
document version.

Roll out in this order:

1. Automated fixtures and local development.
2. Internal users.
3. Small stable production cohort.
4. Increasing cohorts after defined error and rollback thresholds pass.
5. Default-on with the adapter still available.

Document owners, thresholds, monitoring windows, and the rollback command
before each production stage.

## Exit criteria

- The owned engine is the default for the agreed monitoring window.
- Critical workflows pass across input types and supported layouts.
- Failure rates remain within documented thresholds.
- Rollback has been exercised with production-shaped data.
- Migrated scenes remain recoverable without destructive rewriting.

## Rollback

Disable the owned-engine flag, load retained legacy payloads where safe, and
route unsupported post-migration edits through the documented recovery flow.
