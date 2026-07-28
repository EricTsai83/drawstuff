# Whiteboard V3 production cutover

This runbook is operational documentation only. Repository checks do not
authorize production database, snapshot, deployment, or rollback actions.

## Preconditions

- Release candidate has passed format, lint, typecheck, unit/integration,
  Chromium, WebKit, visual, Axe, performance, build, bundle guard, and knip.
- Fixed Apple M1 Chrome/Safari and physical iPhone 12-class Safari results are
  attached to the release.
- An operator has production database, snapshot, deployment, and rollback
  authorization.

## Cutover

1. Run `migrate:whiteboard-v3 --validate` against a production clone and save
   the complete manifest plus checksum.
2. Deploy the release candidate to staging and rerun all gates.
3. Set `WHITEBOARD_WRITES_PAUSED=true` and deploy the maintenance state.
4. Verify Save, Share, and Publish return `WHITEBOARD_MAINTENANCE`/HTTP 503
   while scene load, workspace browse, published reads, and local canvas edits
   remain available.
5. Create a production database snapshot and record its immutable snapshot ID.
6. Run production `--validate` again. Stop if any row is invalid or the
   checksum differs from the approved manifest.
7. Run `--execute --manifest <checksum>`. Batches update only `scene_data` and
   `document_version`; rerunning the same checksum is safe.
8. Run database semantic verification, then `--finalize`.
9. Deploy the V3 application.
10. Smoke test create, load, save, share, publish, images, revision conflict,
    and read-only viewer behavior.
11. Set `WHITEBOARD_WRITES_PAUSED=false`, deploy, and monitor legacy 410s,
    load/save failures, canvas allocation failures, and performance
    diagnostics.

## Failure handling

If migration, verification, deploy, or any smoke test fails:

1. Keep writes paused.
2. Restore the recorded snapshot.
3. Roll back the previous application binary.
4. Verify application/schema compatibility.
5. Resume writes only after both schema and application are consistently on
   the rollback version. Never resume Save/Share in a mixed-schema state.
