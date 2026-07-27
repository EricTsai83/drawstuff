# Phase 5L: Irreversible Whiteboard Legacy Purge

## Goal

Delete every remaining legacy-format, migration, compatibility, rollout, and
rollback artifact after all persisted data is canonical V2.

Completion means zero legacy code, not merely an unused compatibility path.

## Readiness gate

Do not begin until every Phase 5K exit criterion passes and the irreversible
cutover is approved.

## Format and migration removal

- Remove Excalidraw and V1 format detection and parsing.
- Remove all one-time converters, conversion fixtures, and migration tests.
- Remove `WhiteboardLegacyEnvelope`, `originalPayload`, `migrationVersion`,
  source-version fields, and rollback-copy handling.
- Remove dual-format unions and caller-selectable persistence formats.
- Remove legacy writers, exporters, MIME types, file extensions, and import UI.
- Remove old local-storage keys, revision markers, and fallback reads.
- Remove temporary data-audit execution code after archiving its non-sensitive
  final report.

The production parser must reject anything except canonical V2.

### Phase 5J removal inventory

Delete this inventory as one compatibility unit after the Phase 5K audit proves
that no V1, Excalidraw, or unversioned rows remain:

- `src/features/whiteboard/document-format.ts`: V1 parser/serializer,
  Excalidraw detection and parser, `WhiteboardDocumentV1`,
  `WhiteboardLegacyEnvelope`, rollback helpers, compatibility field tables,
  and `prepareWhiteboardDocumentForOwnedEngine`.
- `src/features/whiteboard/document-conversion.ts`: the temporary
  V1/Excalidraw-to-V2 conversion boundary, conversion reports, and
  `convertedFrom` runtime provenance.
- `src/features/whiteboard/owned/store.ts`: remove the temporary converter from
  the file-import boundary and require canonical V2 input directly.
- `src/data/local-storage.ts`: reads of `LOCAL_STORAGE_ELEMENTS`,
  `LOCAL_STORAGE_APP_STATE`, `LOCAL_STORAGE_FILES`,
  `LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT`, legacy/owned revision
  arbitration, and `preferRecovery`.
- `src/lib/import-data-from-db.ts`, `src/lib/published-scene-data.ts`,
  `src/server/whiteboard/published-payload.ts`, and
  `src/server/api/routers/scene.ts`: branches that call the temporary converter
  when nullable `document_version` metadata denotes an old row.
- `tests/fixtures/legacy-scenes/**`,
  `tests/upgrade/whiteboard-document-format.test.ts`,
  `tests/upgrade/whiteboard-recovery.test.ts`, and the V1/Excalidraw cases in
  `tests/upgrade/legacy-scenes.test.ts` and
  `tests/upgrade/whiteboard-loading-boundaries.test.ts`.
- Contract fields and aliases used only by those paths:
  `WhiteboardDocumentV1`, `WhiteboardDocumentMetadata`,
  `WhiteboardLegacyEnvelope`, `WhiteboardPersistenceFormat` legacy members,
  `legacyRollback`, `migratedFromLegacy`, `loadedFromRecovery`, and
  `convertedFrom`.
- `tests/upgrade/whiteboard-persistence-guard.test.ts`: the legacy payload
  fixture proving that the V2-only write guard rejects obsolete formats.

## Transitional architecture removal

- Delete temporary Phase 5A bridge document and editor-state types superseded by
  stable owned types.
- Make `WhiteboardEngine` consume canonical owned domain types directly.
- Remove Excalidraw-shaped optional properties, compatibility `unknown` fields,
  unsafe conversion casts, and fallback branches.
- Remove engine rollout flags, cohort targeting, rollback commands, shadow
  comparisons, and per-engine migration telemetry dimensions.
- Remove obsolete components, hooks, utilities, directories, comments, and
  inaccurate Excalidraw or migration terminology.
- Delete compatibility tests that no longer describe supported behavior.

## Product behavior after purge

- New and updated scenes persist only V2.
- Public and shared scenes read only V2.
- Editable document import/export uses only the Drawstuff format.
- Old `.excalidraw` documents, old shared links, stale clients, and obsolete
  local-storage payloads are intentionally unsupported.
- There is no application switch back to Excalidraw or V1.

## Verification

- Use `rg` across `src`, `tests`, configuration, package manifests, and the
  lockfile to prove no legacy-format, migration-envelope, dual-write, adapter,
  or rollout implementation remains.
- Use dependency analysis to prove removed modules are unreachable.
- Run typecheck, lint, tests, production build, security audit, and
  unused-dependency audit.
- Verify a clean install from the regenerated lockfile.
- Re-run the Phase 5K read-only audit and require only V2 rows.
- Exercise create, edit, autosave, reload, cloud save, share, publish, import,
  export, conflict, offline, and public-viewer workflows.
- Perform final accessibility, performance, memory, desktop, and mobile checks.

## Exit criteria

- Production and tests contain no legacy or migration implementation.
- The application has one canonical document type, parser, serializer, engine,
  renderer, input system, UI, and persistence path.
- Database version constraints accept only the current version.
- No product document contains rollback or source payload data.
- Every temporary item in the removal inventory is deleted.
- Bundle, audit, clean-install, and critical workflow checks pass.

## Recovery

There is no runtime or data-format rollback after this phase. Use forward fixes.
An exceptional full restore requires explicit approval and restores the paired
pre-cutover application, database snapshot, and asset inventory together.
