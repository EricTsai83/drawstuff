# Phase 5D: Owned Canvas Foundation

## Goal

Create the owned canvas renderer and input foundation with viewport navigation,
selection, and hit testing. This phase intentionally does not add drawing
tools.

## Prerequisites

Phases 5A and 5B are merged.

## Engine and renderer

- Implement a TypeScript store that satisfies `WhiteboardEngine`.
- Render through `requestAnimationFrame`.
- Keep pointer-move state outside React.
- Scale backing canvases for `devicePixelRatio`.
- Redraw only when document, viewport, or interaction state changes.
- Separate geometry, input, renderer, and store responsibilities.
- Release animation frames, observers, event listeners, and asset references on
  destroy.

## Viewport

- Pan with pointer and keyboard-supported controls.
- Zoom around the pointer or viewport center.
- Fit content and reset zoom.
- Convert screen and document coordinates consistently.
- Clamp invalid or unusable zoom values.

## Selection

- Hit test visible supported elements in paint order.
- Select one element, clear selection, and drag a marquee.
- Render selection outlines without changing the document.
- Respect locked, hidden, and deleted legacy-imported elements.
- Expose selection through transient editor state.

## Verification

- Unit-test coordinate transforms, bounds, hit testing, and zoom anchoring.
- Test mouse, touch, and pen pointer normalization.
- Verify high-DPI sizing and resize behavior.
- Add small, medium, and large read-only performance fixtures.
- Assert teardown leaves no scheduled frame or registered listener.
- Run the required repository checks.

## Exit criteria

- Owned documents render through the Drawstuff canvas.
- Pan, zoom, fit-to-content, selection, and marquee selection work.
- Pointer movement does not trigger React state updates per frame.
- Performance fixtures establish a repeatable baseline.

## Rollback

Keep the owned engine entry point disabled and render through the Excalidraw
adapter. Owned documents and migration output are unchanged.
