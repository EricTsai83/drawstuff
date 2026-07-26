# Phase 5F: Editing, History, and Clipboard

## Goal

Make owned elements editable through transforms, multi-selection, command
history, clipboard operations, and keyboard commands.

## Prerequisite

Phase 5E is merged.

## Transform tools

- Move selected elements.
- Resize from directional handles.
- Rotate around the selection center.
- Apply transforms consistently to shapes, linear elements, free draw, text,
  and images.
- Preserve aspect ratio through the documented modifier.
- Prevent invalid negative or non-finite geometry.

## Multi-selection

- Add or remove elements with keyboard modifiers.
- Move and transform a group through a shared selection box.
- Keep selection transient and exclude it from persistence.
- Define behavior for locked and mixed-capability selections.

## Command history

- Store semantic document commands rather than canvas frames.
- Coalesce one pointer gesture into one undo entry.
- Clear redo after a new mutation.
- Set explicit memory or entry limits.
- Keep loading, migration, and remote synchronization out of local undo history.

## Clipboard and keyboard

- Copy, cut, paste, duplicate, delete, select all, undo, and redo.
- Remap pasted IDs and offset repeated pastes.
- Ignore editor shortcuts while typing in text or form controls.
- Use a versioned clipboard MIME payload with a safe plain-text fallback.

## Verification

- Test move, resize, and rotate for every supported element type.
- Cover multi-select additions, removals, locked elements, and empty selections.
- Test undo/redo branching, coalescing, limits, and load boundaries.
- Test malformed clipboard payloads and repeated paste behavior.
- Verify Windows/Linux and macOS shortcut variants.
- Run the required repository checks.

## Exit criteria

- Supported elements can be moved, resized, and rotated.
- Multi-selection operations are deterministic.
- Every user mutation has correct undo/redo behavior.
- Clipboard operations never retain duplicate element or asset IDs.

## Rollback

Disable editing capabilities independently while retaining the owned read-only
renderer. Persisted document compatibility is not affected.
