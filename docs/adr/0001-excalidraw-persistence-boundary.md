# ADR 0001: Excalidraw persistence boundary

- Status: Proposed — pending reviewer sign-off before Phase 1
- Date: 2026-07-29
- Upstream baseline: `@excalidraw/excalidraw@0.18.1`
- Upstream tag commit: `a2ec2889babf7d2295469c6d90ebe77fae57df84`

## Context

Drawstuff uses Excalidraw as its only canvas runtime, but it is not a clone of
the hosted Excalidraw application. The pinned upstream implementation is an
executable compatibility baseline, not a requirement to copy Firebase,
Firestore, or every hosted-app storage choice.

The relevant upstream contracts are:

- [JSON serialization](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/data/json.ts)
- [appState storage policy](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/appState.ts)
- [element storage cleaner](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/index.ts)
- [share and collaboration payloads](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/index.ts)
- [collaboration persistence](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/firebase.ts)
- [stateless room relay](https://github.com/excalidraw/excalidraw-room/blob/03ff435860b508d7cd9e005cfc90f7977ae2a593/src/index.ts)

## Decision

### Native document boundary

The editor and persistence adapters use native `ExcalidrawElement[]`,
`AppState`, and `BinaryFiles`. Drawstuff does not own an alternative element
shape and does not normalize element fields into relational tables.

Owned snapshots preserve element order, fractional `index`, bindings,
`version`, `versionNonce`, `updated`, `customData`, deleted tombstones, and
unknown future fields. Drawstuff metadata such as name, workspace, categories,
publish state, archive state, owner, and revision remains authoritative in
relational columns.

### Storage profiles

| Profile | Elements | appState | Binary assets |
| --- | --- | --- | --- |
| `owned-scene` | Complete native array, including tombstones | Official server allowlist | External objects plus metadata in the V4 envelope |
| `readonly-share` | Non-deleted elements; linear transient point cleared | Official server allowlist | Separately encrypted objects; none in the scene envelope |
| `local-export` | Upstream export cleaner | Official export allowlist | Only files referenced by live elements |
| `collaboration-snapshot` | Live visible elements plus tombstones newer than 24 hours | None | Separate encrypted storage |

The owned profile intentionally differs from the hosted app. Keeping all
tombstones in an owned revision is useful for optimistic concurrency,
recovery, audit, and a later collaboration migration. Share and collaboration
profiles stay narrow because their lifecycle and disclosure boundaries differ.

### appState

Cloud scene documents have one allowlist:

```text
gridSize
gridStep
gridModeEnabled
viewBackgroundColor
```

Theme, viewport, zoom, selection, dialogs, collaborators, and presence are
user/session state. Existing V4 documents containing `theme` remain readable,
but all new writers strip it through the shared adapter.

### Assets

Binary content stays in object storage. A file record needs an explicit,
immutable `excalidraw_file_id`; `name` is not a durable identity field.
`storage key`, MIME type, byte size, content hash, ownership, and parent scene
or share remain product metadata.

One scene can contain different Excalidraw file IDs with identical content.
Therefore `(scene_id, content_hash)` can be indexed for lookup but cannot be
the identity constraint. Identity is `(scene_id, excalidraw_file_id)` or
`(shared_scene_id, excalidraw_file_id)`.

### Encryption key ownership

Readonly shares store opaque compressed ciphertext. The key exists only in
the URL fragment and client memory. It must not be sent to the server or
written to the database, logs, traces, analytics, or error payloads. Share
assets use the same client-owned key but are stored separately.

### Version namespaces

- `drawstuffDocumentVersion = 4` identifies the Drawstuff envelope.
- `upstreamExcalidrawFormatVersion = 2` identifies the `.excalidraw` format.
- `engine.version = 0.18.1` identifies the pinned editor/contract baseline.

Code, validation errors, telemetry, and migration reports must keep these
names distinct.

### Realtime collaboration readiness

Realtime transport, presence, cursor state, room membership, and volatile
events do not belong in PostgreSQL scene payloads.

The future collaboration path will use three explicit boundaries:

1. `getOfficialSyncableElements()` prepares durable or relay-safe element
   snapshots using the pinned tombstone and visibility policy.
2. An Excalidraw `reconcileElements` adapter will own merge semantics. The
   application will not invent a second merge algorithm or custom CRDT.
3. Relay messages remain opaque to the relay. Presence is volatile, while a
   durable snapshot is an independently encrypted storage concern.

When collaboration implementation starts, the adapter will be differential
tested against the then-pinned Excalidraw version before changing retention
or reconciliation behavior. A dependency upgrade never changes production
storage behavior implicitly.

## V4 decision

V4 is sufficient. The gaps are resolvable with backward-compatible writer
narrowing, profile-specific codecs, and explicit asset identity. V5 is not
justified because the current V4 reader can read both old and corrected V4
documents without ambiguity.

## Consequences

- The code has profile-specific entry points instead of one shared cloud
  serializer.
- Upstream serializer/restore behavior is covered by executable fixtures.
- Existing V4 `theme` data is tolerated on read and disappears on the next
  write.
- The proposed asset DDL must pass collision and reference reports in an
  isolated database before it can become a migration.
- Realtime collaboration can reuse the native element model and official
  reconciliation semantics without replacing owned-scene storage.
