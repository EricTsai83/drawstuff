# Phase 5C: Owned Whiteboard UI Shell

## Goal

Replace product-facing Excalidraw controls with a Drawstuff-owned shell built
from Tailwind, Base UI/shadcn, and Lucide while the Excalidraw adapter still
renders the canvas.

## Prerequisite

Phase 5A is merged. Phase 5B may proceed in parallel after the shared contracts
are stable.

## Scope

Build engine-controlled UI for:

- Primary drawing toolbar.
- Element properties panel.
- Main and context menus.
- Zoom and viewport controls.
- Fill, color, stroke, and opacity controls.
- Import, export, rename, share, and workspace dialogs.
- Tooltips and keyboard shortcut help.
- Desktop and mobile layouts.

All controls must call `WhiteboardEngine`; they must not query or mutate
Excalidraw DOM nodes.

## Design-system rules

- Reuse installed shadcn components before adding new primitives.
- Use Base UI composition and the project semantic color tokens.
- Keep dialogs titled and keyboard accessible.
- Use Lucide icons through existing button icon conventions.
- Avoid large CSS overrides and undocumented Excalidraw selectors.
- Keep product actions separate from engine-specific rendering controls.

## Verification

- Add interaction tests for tool changes, property changes, menus, dialogs,
  zoom, keyboard shortcuts, and disabled states.
- Verify focus order, visible focus, labels, tooltip access, and escape
  behavior.
- Test narrow mobile, tablet, and desktop layouts.
- Run the required repository checks.

## Exit criteria

- Product-facing controls use the Drawstuff design system.
- The same UI can control the Excalidraw adapter or a test engine.
- UI tests assert engine calls rather than Excalidraw implementation details.
- No new code relies on Excalidraw DOM structure or CSS class names.

## Rollback

Switch the editor entry point back to the existing Excalidraw UI composition.
The engine adapter and document work remain usable.
