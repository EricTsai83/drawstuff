# Phase 5G: Assets, Export, and Public Viewer

## Goal

Complete image asset handling, portable export, and the read-only public viewer
so critical workflows no longer require Excalidraw rendering.

## Prerequisite

Phase 5F is merged.

## Images and assets

- Import supported image formats with size and type validation.
- Store asset metadata separately from image elements.
- Resolve local, database, shared, and published asset payloads.
- Deduplicate assets without merging distinct content incorrectly.
- Remove unreferenced assets only after document references are evaluated.
- Render missing or failed assets with a stable placeholder.

## Export

- Export PNG at device-independent dimensions and configurable scale.
- Export SVG with escaped text and safe embedded or referenced images.
- Export the versioned owned document.
- Define background, bounds, padding, transparency, and selection behavior.
- Prevent active selections, controls, or transient overlays from appearing.

## Read-only viewer

- Render owned and legacy-imported scenes.
- Fit content on initial load.
- Support zoom, pan, theme, reset, and fullscreen behavior.
- Exclude editing commands and mutation-capable engine methods.
- Preserve published-scene error and access states.

## Verification

- Test valid, missing, corrupt, oversized, and unsupported assets.
- Compare PNG/SVG output with stable scene fixtures.
- Run SVG security tests for text, URLs, and embedded data.
- Test viewer loading for local fixtures and published-scene payload shapes.
- Visually compare supported legacy fixtures against the Excalidraw viewer.
- Run the required repository checks.

## Exit criteria

- Image assets load, persist, and export through owned contracts.
- PNG, SVG, and document exports work without Excalidraw.
- The public viewer uses the owned renderer.
- Read-only mode exposes no document mutation path.

## Rollback

Route public viewing and export back to the adapter while retaining owned
documents and assets. Do not rewrite stored scenes during rollback.
