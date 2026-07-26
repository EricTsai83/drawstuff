# Phase 5B: Owned Document Format and Legacy Import

## Goal

Create a versioned Drawstuff document format and a deterministic one-way
legacy importer while keeping every existing scene readable and recoverable.

## Prerequisite

Phase 5A contracts and adapter are merged.

## Owned format

Introduce a versioned persisted shape:

```ts
interface WhiteboardDocumentV1 {
  version: 1;
  elements: WhiteboardElement[];
  assets: Record<string, WhiteboardAsset>;
  metadata: WhiteboardDocumentMetadata;
}
```

Persist document content and metadata only. Keep selection, dialogs, active
tool, pointer interaction state, and most viewport state in the editor session.

## Legacy importer

Implement the one-way conversion:

```text
Excalidraw scene → WhiteboardDocumentV1
```

- Parse legacy data without importing the Excalidraw runtime.
- Convert supported elements and assets deterministically.
- Record unsupported or unknown fields in a rollback-safe legacy envelope.
- Reject malformed input with typed errors rather than partial writes.
- Preserve the original payload until the migrated scene is proven safe.
- Never rewrite production scenes in place.

## Persistence transition

- Add explicit format detection at every scene-loading boundary.
- Continue reading legacy local, database, shared, and published scenes.
- Write the new format only through an opt-in path used by tests and later
  rollout work.
- Define how original legacy payloads and migration versions are retained.

## Verification

- Add fixed legacy fixtures for every supported element and asset type.
- Assert byte-for-byte deterministic migration output.
- Cover missing assets, deleted elements, malformed payloads, unknown fields,
  and newer unsupported versions.
- Round-trip owned documents through local and server serialization.
- Run the required repository checks.

## Exit criteria

- Existing scenes remain readable without mutation.
- New persistence code does not depend on Excalidraw `AppState` or
  `BinaryFiles`.
- Legacy fixtures migrate deterministically.
- A failed migration leaves the original scene untouched and produces an
  actionable error.

## Rollback

Disable owned-format writes and continue loading the retained legacy payload.
Do not delete migration metadata or rollback copies.
