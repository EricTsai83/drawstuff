# Excalidraw 0.18.1 persistence gap report

This report compares the V2, V3, and V4 corpus with the pinned Excalidraw
`0.18.1` persistence contracts. The executable comparisons live in
`apps/web/tests/excalidraw-persistence-contract.test.ts` and
`apps/web/tests/excalidraw-document-v4.test.ts`.

## Field comparison

| Area | V2 raw Excalidraw | V3 owned Whiteboard | V4 after alignment | Classification |
| --- | --- | --- | --- | --- |
| Element order and IDs | Preserved | Preserved | Preserved | preserved |
| Native element fields | Preserved when present | Historical projection lost some fields | Preserved, including unknown future fields | V3 missing/lossy; V4 preserved |
| `index`, bindings, `version`, `versionNonce`, `updated` | Preserved when present | Some payloads renamed or omitted fields | Preserved unchanged | V3 missing/lossy |
| V3 source payload | N/A | Embedded under `customData.drawstuffWhiteboardV3` during conversion | Reader-only compatibility data | intentionally Drawstuff-specific |
| Deleted elements in owned scene | Input-dependent | Input-dependent | Preserved | intentionally Drawstuff-specific |
| Deleted elements in readonly share/local export | Removed by upstream cleaner | Removed after conversion | Removed by profile codec | stripped by official contract |
| Expired collaboration tombstones | N/A | N/A | Removed after 24 hours | stripped by official contract |
| Invisible live collaboration elements | N/A | N/A | Removed from collaboration snapshot | stripped by official contract |
| `gridSize`, `gridStep`, `gridModeEnabled`, `viewBackgroundColor` | Preserved when present | Converted when present | Preserved | preserved |
| `theme` in cloud document | Present in some payloads | Converted by old writer | Read-compatible, stripped by new writers | stripped by official contract |
| viewport, zoom, selection, dialogs, collaborators | Present in some raw payloads | Not consistently modeled | Stripped by every cloud writer | stripped by official contract |
| Drawstuff name/workspace/category/publish/revision | Outside raw payload | Partly embedded | Relational metadata is authoritative | intentionally Drawstuff-specific |
| Drawstuff envelope version | None | `3` | `4` | intentionally Drawstuff-specific |
| Upstream `.excalidraw` format version | Usually `2` | Not equivalent | Kept as a separate namespace | preserved without conflation |
| Binary content in scene payload | Possible in local files | External asset records | External object storage | intentionally Drawstuff-specific |
| Excalidraw `fileId` mapping | No relational mapping | Name-based mapping | Explicit field proposed | missing until proposal is promoted |
| Encryption key | Client/URL dependent | Client/URL dependent | URL fragment/client only | preserved security boundary |

## Storage profile result

| Profile | Differential result | Remaining exception |
| --- | --- | --- |
| `owned-scene` | Native semantic digest is stable through V4 compression round-trip | Keeps tombstones intentionally |
| `readonly-share` | Matches upstream database element/appState cleanup | Uses a Drawstuff V4 envelope before encryption |
| `local-export` | Matches upstream `serializeAsJSON(..., "local")` fixture | Source is supplied by the caller for deterministic tests |
| `collaboration-snapshot` | Matches upstream 24-hour tombstone and invisible-element policy | Merge/relay are deferred, with `reconcileElements` reserved as the merge boundary |

## Asset identity gap

The current `file_record.name` contains the Excalidraw file ID because uploaded
files are named with the ID. This is recoverable but implicit. It also
conflicts with content-only deduplication: two different Excalidraw IDs may
legitimately reference identical bytes.

The proposal in
`apps/web/drizzle/proposals/0002_file_record_excalidraw_file_id.sql`:

1. reports empty candidates and parent-scoped collisions;
2. adds and backfills `excalidraw_file_id`;
3. replaces name-based identity with parent/file-ID uniqueness; and
4. changes content hash uniqueness into a lookup index.

It is a proposal, not an applied migration. It must run against the Phase 1
integration database and a production clone before promotion.

## Decision

Use a backward-compatible V4 adjustment. Do not introduce V5.

Reasons:

- old and corrected V4 documents are unambiguous to the current reader;
- theme removal is writer narrowing, not a document-shape change;
- profile-specific tombstone behavior is a serializer concern;
- explicit file identity is relational metadata, not a scene-envelope change;
- the native element boundary already supports future collaboration and
  official reconciliation semantics.
