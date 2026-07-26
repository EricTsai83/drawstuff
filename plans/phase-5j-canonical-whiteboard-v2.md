# Phase 5J: Canonical Whiteboard V2 and Owned-Only Writes

## Goal

Finalize the document and persistence design built in Phases 5A through 5I
without reimplementing those phases. Promote the working owned format into one
canonical final format and stop creating new legacy or migration-bearing data.

Phase 5J builds on the existing engine, renderer, tools, editing, assets, and UI.
It does not replace their completed implementations.

## Prerequisite

Phase 5I is merged. The Excalidraw runtime and dependency are gone, and the
runtime-free importer is still temporarily available for data convergence.

## Canonical document

Introduce `WhiteboardDocumentV2` as the final persisted format for this
program:

```ts
interface WhiteboardDocumentV2 {
  version: 2;
  elements: WhiteboardElementV2[];
  assets: Record<string, WhiteboardAssetV2>;
  metadata: WhiteboardDocumentMetadataV2;
}
```

Derive V2 from the implemented owned V1 behavior while removing transition
artifacts:

- Remove `legacy`, `originalPayload`, `migrationVersion`, and source-version
  data from canonical metadata.
- Keep editor session state out of persisted documents.
- Use Drawstuff-owned element, asset, metadata, and editor-state types.
- Tighten stringly typed or optional bridge fields where the implemented owned
  engine now has stable requirements.
- Reject malformed, non-finite, unsupported, and future-version data with typed
  errors.
- Serialize deterministically.

The V1 and Excalidraw parsers remain temporary read/conversion inputs until
Phase 5L. They must never write V1 or Excalidraw data after this phase.

## Persistence contract

- Make every local, cloud, shared, published, autosave, duplicate, import, and
  export write produce canonical V2.
- Remove caller-selectable persistence formats and legacy defaults.
- Make the save API require the current document version.
- Reject stale clients that omit or send a non-current write version.
- Use one canonical parser and serializer for new product behavior.
- Do not embed source payloads or rollback copies in V2.

## Database version metadata

Add explicit version metadata beside opaque compressed payloads:

- `scene.document_version`
- `shared_scene.document_version`

Add the columns as nullable while old rows are pending Phase 5K conversion.
Every new write must set the current version. Phase 5K backfills existing rows
and makes the columns required.

Do not change scene IDs, users, workspaces, categories, publication fields,
revisions, timestamps, or asset relationships merely to add version metadata.

## Temporary conversion boundary

- Keep V1/Excalidraw-to-V2 conversion isolated from normal V2 readers and
  writers.
- Never import the converter into code paths that already require V2.
- Report unsupported fields, unsupported elements, and missing assets.
- Refuse partial conversion.
- Register the converter, fixtures, format branches, and compatibility types
  for deletion in Phase 5L.

## Verification

- Test every V2 element and asset variant.
- Test deterministic serialization and strict parsing.
- Round-trip V2 through local and server compression.
- Verify every successful new write records version 2.
- Verify stale clients cannot create non-V2 data.
- Verify V2 contains no embedded legacy or rollback payload.
- Run the required repository checks.

## Exit criteria

- All new writes use V2.
- Legacy writes and missing-version writes are zero.
- V2 contains no legacy or migration envelope.
- Existing Phase 5A–5I features behave through the V2 persistence boundary.
- Temporary conversion artifacts have a complete Phase 5L removal inventory.

## Rollback

Before Phase 5K rewrites production data, revert the V2 write switch and schema
addition together. Do not downgrade documents written as V2.
