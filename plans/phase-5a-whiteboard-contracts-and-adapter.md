# Phase 5A: Whiteboard Contracts and Excalidraw Adapter

## Goal

Introduce an engine-independent boundary for the editor without changing
current user behavior. Product code should depend on Drawstuff-owned contracts
while Excalidraw remains the active implementation behind an adapter.

## Scope

Define the initial contracts under `src/features/whiteboard/`:

- `WhiteboardDocument`
- `WhiteboardElement`
- `WhiteboardAsset`
- `WhiteboardViewport`
- `WhiteboardTool`
- `WhiteboardEditorState`
- `WhiteboardEngine`

The engine contract must cover:

- Load and read the active document.
- Subscribe to document and editor state.
- Select and change tools.
- Read and update the viewport.
- Undo and redo.
- Add and retrieve assets.
- Export images and documents.
- Destroy subscriptions and release resources.

Create `ExcalidrawEngineAdapter` and move Excalidraw runtime and type access
behind the adapter. Keep conversion helpers inside
`src/features/whiteboard/adapters/excalidraw/`.

## Boundaries

- Do not introduce the owned document format in this phase.
- Do not redesign the toolbar or canvas.
- Do not change persisted scene payloads.
- Do not remove `@excalidraw/excalidraw`.
- Keep high-frequency pointer state out of React contracts.

## Verification

- Add contract tests for subscriptions, teardown, tool selection, viewport
  updates, undo/redo delegation, assets, and export delegation.
- Exercise existing local, database, shared-link, and published-scene flows.
- Confirm product modules no longer receive `ExcalidrawImperativeAPI`.
- Run the required repository checks.

## Exit criteria

- Product-facing editor code talks to `WhiteboardEngine`.
- Direct Excalidraw imports are isolated to the adapter and existing legacy
  migration code.
- Adapter teardown releases every listener it creates.
- Existing scenes behave exactly as before.

## Rollback

Revert the contract wiring and restore direct Excalidraw API injection. No data
migration is required because this phase does not change persistence.
