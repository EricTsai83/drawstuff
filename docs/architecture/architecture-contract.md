# Drawstuff architecture contract

- Status: Accepted
- Related decisions: [ADR 0001](../adr/0001-excalidraw-persistence-boundary.md),
  [public API gap audit](./excalidraw-public-api-gap-audit.md), and
  [native UI integration contract](./native-ui-integration-contract.md)

This document is the current architecture boundary for Drawstuff's Excalidraw integration. It
defines ownership and compatibility rules; it is not an implementation history.

## Ownership

| Component                        | Owns                                                                                                                                        | Must not own                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@drawstuff/excalidraw-adapter`  | The only upstream integration boundary, native document/Library restore, render bridge, reconciliation wrapper, and upstream contract tests | Product UI, transport, room lifecycle, user persistence, or another element model               |
| `apps/web`                       | Product layout, dialogs, menus, user-scoped Library persistence, persistence UI, authentication, and collaboration composition              | A direct Excalidraw dependency, canvas engine, Library/scene merge algorithm, or history engine |
| `@drawstuff/collaboration`       | Transport-neutral protocol, crypto, recovery, room/presence contracts, and collaboration orchestration                                      | React/Next.js UI, relay process, persistence, or canvas primitives                              |
| `@drawstuff/collaboration-relay` | Authenticated connections, bounded opaque fanout, health, metrics, and graceful drain                                                       | React, app code, adapter code, scene plaintext, or durable canvas state                         |

The allowed dependency graph is:

```text
apps/web ───────────────→ @drawstuff/excalidraw-adapter
    │
    └→ @drawstuff/collaboration ─→ @drawstuff/excalidraw-adapter

@drawstuff/collaboration-relay ─→ @drawstuff/collaboration/protocol
```

Arrows are one-way. Reverse dependencies and cross-layer deep imports are architecture defects.
The collaboration server entry points must remain free of React, app, adapter, DOM/CSS, and
browser-only modules.

## Upstream boundary

Only adapter source and adapter-owned upstream contract tests may import
`@excalidraw/excalidraw` directly. The web app consumes narrow adapter exports and must not depend
on upstream private modules.

Excalidraw remains the sole owner of:

- the element model, fractional ordering, and tombstones;
- bindings and bound-text/linear-element invariants;
- undo/redo history;
- restore, cleaning, and serialization semantics;
- complete `LibraryItems`, Library item restoration, and Library merge semantics;
- `reconcileElements` conflict resolution and merge ordering.

Drawstuff must not copy or reimplement those responsibilities. Missing public customization APIs
are accepted product constraints unless the owner explicitly approves a new integration seam.
The current policy is to keep the native editor UI and use only public props and render slots: no
patch, fork, private API, DOM workaround, or CSS override may be introduced except the isolated,
documented accessibility limitation in the native UI contract.

Personal Library storage crosses the same adapter boundary: the web app persists one compressed,
revisioned snapshot per authenticated user, while the adapter delegates item restore and merge to
upstream. The row is user-scoped rather than scene-, workspace-, or collaboration-scoped. Official
catalog installation is a one-time bounded import; stored content is the complete upstream snapshot,
not a catalog ID or source URL, so normal loads never depend on the catalog being reachable.

## Native document and compatibility boundary

Editor, persistence, and collaboration paths use native `ExcalidrawElement[]`, `AppState`, and
`BinaryFiles`. Drawstuff does not normalize elements into an application-owned schema.

Owned documents preserve element order, fractional `index`, bindings, `version`, `versionNonce`,
`updated`, `customData`, deleted tombstones, and unknown future fields. Product metadata such as
name, workspace, category, archive/publish state, owner, and revision remains relational.

`drawstuffDocumentVersion`, the upstream `.excalidraw` file version, collaboration transport
version, and installed npm engine version are separate namespaces. One must never be used as a
compatibility gate for another. A reader for real stored legacy data is a tested, versioned
contract; speculative readers, silent fallbacks, dual writes, and compatibility shims without an
owner and removal proof are forbidden.

The persistence profiles, app-state allowlists, and asset relation rationale live in
[ADR 0001](../adr/0001-excalidraw-persistence-boundary.md). The collaboration-specific runtime
contract lives in [collaboration system design](./collaboration-system-design.md).

## Enforcement and change rules

- ESLint and package-contract tests enforce direct-import and dependency boundaries.
- Upstream surface tripwires require both typecheck and tests on every Excalidraw upgrade.
- Replaced runtime paths, exports, dependencies, feature flags, fixtures, and tests are removed in
  the same change that supersedes them.
- Runtime external input is byte-bounded before decoding and runtime validation.
- Hot paths do not serialize or broadcast the full scene on pointer movement or every `onChange`,
  and do not introduce unbounded queues or caches.
- Database and compatibility changes follow
  [engineering conventions](../operations/engineering-conventions.md).
