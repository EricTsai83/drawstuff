# Phase 5: Replace Excalidraw With an Owned Whiteboard

## Goal

Replace `@excalidraw/excalidraw` with a Drawstuff-owned whiteboard component
built with TypeScript, React, Tailwind, and Base UI while preserving existing
user scenes.

This is an editor-engine project, not only a toolbar redesign. Excalidraw
currently provides rendering, geometry, input handling, scene state, history,
serialization, export, assets, and UI.

## Non-goals for the first release

- Full Excalidraw feature parity.
- Real-time multiplayer collaboration.
- Mermaid conversion.
- Embeddables.
- Complete Excalidraw library support.
- Advanced elbow-arrow and binding behavior.
- Bidirectional compatibility with every future Excalidraw file format.

## Proposed structure

```text
src/features/whiteboard/
├── adapters/
│   └── excalidraw/
├── engine/
├── geometry/
├── input/
├── migrations/
├── model/
├── renderer/
└── ui/
```

React owns UI. The high-frequency canvas engine should use a TypeScript store
and `requestAnimationFrame` rather than React state for every pointer movement.

## Milestone 1: Internal contracts

Define engine-independent types:

- `WhiteboardDocument`
- `WhiteboardElement`
- `WhiteboardAsset`
- `WhiteboardViewport`
- `WhiteboardTool`
- `WhiteboardEditorState`
- `WhiteboardEngine`

The engine contract should cover:

- Load and read document.
- Subscribe to state.
- Select and change tools.
- Update viewport.
- Undo/redo.
- Add and retrieve assets.
- Export image/document.
- Destroy and release resources.

Create `ExcalidrawEngineAdapter` and move all direct Excalidraw runtime and type
imports behind that boundary.

### Exit criteria

- Product code talks to `WhiteboardEngine`, not
  `ExcalidrawImperativeAPI`.
- Excalidraw-specific types are isolated under the adapter and migration
  modules.
- Current behavior is unchanged.

## Milestone 2: Owned document format

Introduce a versioned format such as:

```ts
interface WhiteboardDocumentV1 {
  version: 1;
  elements: WhiteboardElement[];
  assets: Record<string, WhiteboardAsset>;
}
```

Separate persisted document data from transient editor state:

- Persist elements, assets, and document metadata.
- Keep current selection, open dialogs, active tool, and most viewport state in
  the editor session.

Build a one-way legacy importer:

```text
Excalidraw scene → WhiteboardDocumentV1
```

Preserve unknown legacy data until the migration is proven safe. Never rewrite
production scenes in place without a rollback copy or versioned migration.

### Exit criteria

- Legacy fixtures migrate deterministically.
- Existing scenes remain readable.
- New persistence code no longer depends on Excalidraw `AppState` or
  `BinaryFiles`.

## Milestone 3: Owned UI shell

Build with Tailwind, Base UI/shadcn, and Lucide:

- Toolbar.
- Properties panel.
- Main and context menus.
- Zoom controls.
- Color and stroke controls.
- Dialogs and tooltips.
- Keyboard shortcut help.

All controls call `WhiteboardEngine`. During the transition, the engine can
still be the Excalidraw adapter.

Avoid relying on undocumented Excalidraw DOM selectors or large CSS overrides.

### Exit criteria

- Product-facing controls use the Drawstuff design system.
- UI behavior is covered by interaction tests.
- The same UI can control either engine implementation.

## Milestone 4: Canvas engine MVP

Implement in this order:

1. Viewport, pan, and zoom.
2. Selection and hit testing.
3. Rectangle, ellipse, and diamond.
4. Line and arrow.
5. Free draw.
6. Text editing with an HTML overlay.
7. Move, resize, and rotate.
8. Multi-select.
9. Undo/redo command history.
10. Clipboard and keyboard commands.
11. Images and assets.
12. PNG/SVG export.
13. Read-only viewer mode.

Small focused dependencies such as `roughjs` and `perfect-freehand` are
acceptable as direct dependencies if their licenses and APIs are reviewed.
Avoid replacing Excalidraw with another large canvas framework unless it
materially reduces the required engine work.

### Performance rules

- Render through `requestAnimationFrame`.
- Keep pointer-move state outside React.
- Use device-pixel-ratio-aware canvases.
- Redraw only when document, viewport, or interaction state changes.
- Establish performance fixtures for small, medium, and large scenes.

## Milestone 5: Migration and rollout

- Put the new engine behind a feature flag.
- Support both legacy read and new-format write during the rollout.
- Compare Excalidraw and new-engine rendering using scene fixtures.
- Test desktop pointer, touch, pen, keyboard, and mobile layouts.
- Enable the new engine for internal users first.
- Monitor load, save, export, and migration failures.
- Keep a rollback route to the Excalidraw adapter until migrated scenes are
  proven stable.

## Milestone 6: Dependency removal

Before removing Excalidraw:

- No production module imports `@excalidraw/excalidraw`.
- Existing local, database, shared, and published scenes open correctly.
- Image assets and exports work.
- The public viewer uses the new renderer.
- The legacy importer does not require Excalidraw at runtime.
- Security, accessibility, performance, and mobile checks pass.

Then:

- Remove `@excalidraw/excalidraw`.
- Remove Excalidraw CSS imports and adapters.
- Regenerate the lockfile.
- Re-run security and unused-dependency audits.
- Compare client bundle output.

## Suggested delivery estimate

- Contracts and adapter: 1–2 weeks.
- Document model and migration: 1–2 weeks.
- Owned UI shell: 1–3 weeks.
- Canvas MVP: 4–8 weeks.
- Migration and production hardening: 4–8+ weeks.

Full Excalidraw parity remains a multi-month effort and should not block the
smaller product-focused MVP.

## Exit criteria

- Drawstuff owns the editor API, document format, renderer, input system, and
  product UI.
- Existing user scenes are preserved.
- `@excalidraw/excalidraw` is absent from `package.json` and the lockfile.
- The required checks and critical workflow tests pass.

