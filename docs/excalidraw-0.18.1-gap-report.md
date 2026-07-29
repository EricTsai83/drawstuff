# Excalidraw 0.18.1 persistence gap report

This historical report compares the V2, V3, and V4 corpus with the Excalidraw
`0.18.1` reference persistence contracts. These fixtures remain as backward
compatibility coverage; they do not pin the installed package version. The
executable comparisons live in
`apps/web/tests/excalidraw-persistence-contract.test.ts` and
`apps/web/tests/excalidraw-document-v4.test.ts`.

## Field comparison

| Area                                                             | V2 raw Excalidraw            | V3 owned Whiteboard                                                 | V4 after alignment                         | Classification                               |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Element order and IDs                                            | Preserved                    | Preserved                                                           | Preserved                                  | preserved                                    |
| Native element fields                                            | Preserved when present       | Historical projection lost some fields                              | Preserved, including unknown future fields | V3 missing/lossy; V4 preserved               |
| `index`, bindings, `version`, `versionNonce`, `updated`          | Preserved when present       | Some payloads renamed or omitted fields                             | Preserved unchanged                        | V3 missing/lossy                             |
| V3 source payload                                                | N/A                          | Embedded under `customData.drawstuffWhiteboardV3` during conversion | Reader-only compatibility data             | intentionally Drawstuff-specific             |
| Deleted elements in owned scene                                  | Input-dependent              | Input-dependent                                                     | Preserved                                  | intentionally Drawstuff-specific             |
| Deleted elements in readonly share/local export                  | Removed by upstream cleaner  | Removed after conversion                                            | Removed by profile codec                   | stripped by official contract                |
| `gridSize`, `gridStep`, `gridModeEnabled`, `viewBackgroundColor` | Preserved when present       | Converted when present                                              | Preserved                                  | preserved                                    |
| `theme` in cloud document                                        | Present in some payloads     | Converted by old writer                                             | Read-compatible, stripped by new writers   | stripped by official contract                |
| viewport, zoom, selection, dialogs, collaborators                | Present in some raw payloads | Not consistently modeled                                            | Stripped by every cloud writer             | stripped by official contract                |
| Drawstuff name/workspace/category/publish/revision               | Outside raw payload          | Partly embedded                                                     | Relational metadata is authoritative       | intentionally Drawstuff-specific             |
| Drawstuff envelope version                                       | None                         | `3`                                                                 | `4`                                        | intentionally Drawstuff-specific             |
| Upstream `.excalidraw` format version                            | Usually `2`                  | Not equivalent                                                      | Kept as a separate namespace               | preserved without conflation                 |
| Binary content in scene payload                                  | Possible in local files      | External asset records                                              | External object storage                    | intentionally Drawstuff-specific             |
| Excalidraw `fileId` mapping                                      | No relational mapping        | Name-based mapping                                                  | Explicit field required                    | missing until final Drizzle schema is pushed |
| Encryption key                                                   | Client/URL dependent         | Client/URL dependent                                                | URL fragment/client only                   | preserved security boundary                  |

## Storage profile result

| Profile          | Differential result                                                | Remaining exception                                      |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `owned-scene`    | Native semantic digest is stable through V4 compression round-trip | Keeps tombstones intentionally                           |
| `readonly-share` | Matches upstream database element/appState cleanup                 | Uses a Drawstuff V4 envelope before encryption           |
| `local-export`   | Matches upstream `serializeAsJSON(..., "local")` fixture           | Source is supplied by the caller for deterministic tests |

## Asset identity gap

The current `file_record.name` contains the Excalidraw file ID because uploaded
files are named with the ID. This is recoverable but implicit. It also
conflicts with content-only deduplication: two different Excalidraw IDs may
legitimately reference identical bytes.

Plan 16 replaces the implicit mapping through a final Drizzle schema change
that:

1. reports empty candidates and parent-scoped collisions;
2. adds and backfills `excalidraw_file_id`;
3. replaces name-based identity with parent/file-ID uniqueness; and
4. changes content hash uniqueness into a lookup index.

There is intentionally no migration SQL proposal. The change must be exercised
against an isolated production-like clone using a nullable schema push, a
bounded/idempotent data backfill, an audited final-constraint push, and a
restore drill before the same `pnpm db:push` sequence reaches the target
database. Any destructive prompt or DDL that Drizzle cannot safely express
requires stopping and asking the user before a migration file is considered.

## Decision

Use a backward-compatible V4 adjustment. Do not introduce V5.

Reasons:

- old and corrected V4 documents are unambiguous to the current reader;
- theme removal is writer narrowing, not a document-shape change;
- profile-specific tombstone behavior is a serializer concern;
- explicit file identity is relational metadata, not a scene-envelope change;
- the native element boundary already supports future collaboration and
  official reconciliation semantics.
