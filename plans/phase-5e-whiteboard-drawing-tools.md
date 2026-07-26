# Phase 5E: Owned Drawing Tools

## Goal

Add the MVP creation tools to the owned canvas after rendering, viewport, and
selection behavior are stable.

## Prerequisite

Phase 5D is merged.

## Delivery batches

Implement and review these as separate commits or pull requests where useful:

1. Rectangle, ellipse, and diamond.
2. Line and arrow.
3. Free draw.
4. Text editing through an HTML overlay.

Each tool must:

- Create owned-format elements with stable IDs and defaults.
- Show an in-progress preview without persisting every pointer move.
- Commit one document change when the gesture completes.
- Cancel cleanly with Escape or pointer cancellation.
- Handle zero-size gestures and pointer loss.
- Work with mouse, touch, and pen input.

## Geometry and rendering

- Keep element geometry independent from UI controls.
- Define fill, stroke, opacity, and roughness-like style fields in owned types.
- Use focused dependencies such as `roughjs` or `perfect-freehand` only after
  reviewing license, bundle cost, maintenance, and API stability.
- Do not adopt another full canvas framework by default.

## Text editing

- Position the HTML editor through the shared coordinate transform.
- Preserve line breaks and empty-line behavior.
- Commit on the defined blur or keyboard action and support cancellation.
- Keep text input accessible to input methods and mobile keyboards.

## Verification

- Add geometry snapshots for each supported element.
- Cover click-only, reverse-direction, tiny, off-canvas, and cancelled gestures.
- Test stylus pressure only if it affects stored or rendered output.
- Add interaction tests for text commit and cancel behavior.
- Compare migrated and newly created element rendering.
- Run the required repository checks.

## Exit criteria

- Users can create every MVP element type.
- A completed gesture creates one undoable document mutation.
- Preview state remains transient.
- New elements serialize without Excalidraw types.

## Rollback

Disable individual tools through engine capability flags while keeping the
owned viewer and selection foundation active.
