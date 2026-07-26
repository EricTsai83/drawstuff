# Phase 5I: Excalidraw Dependency Removal

## Goal

Remove the Excalidraw runtime, adapter, CSS, and dependency only after the owned
whiteboard has proven it can serve existing scenes and critical workflows.

## Readiness gate

Do not begin removal until:

- No production module outside the adapter or migration boundary imports
  `@excalidraw/excalidraw`.
- Existing local, database, shared, and published scenes open correctly.
- Images and PNG, SVG, and document exports work.
- The public viewer uses the owned renderer.
- The legacy importer does not require Excalidraw at runtime.
- Security, accessibility, performance, desktop, and mobile checks pass.
- Phase 5H monitoring and rollback requirements are satisfied.

## Removal

- Remove `ExcalidrawEngineAdapter` and its capability flag.
- Remove all Excalidraw runtime and type imports.
- Remove Excalidraw CSS imports and selector overrides.
- Remove obsolete compatibility components, hooks, utilities, and tests.
- Remove `@excalidraw/excalidraw` from `package.json`.
- Regenerate `pnpm-lock.yaml` through pnpm.
- Keep the runtime-free legacy importer and retained rollback data policy.
- Rename remaining product paths that inaccurately use `excalidraw`.

## Verification

- Use `rg` and dependency analysis to prove no runtime import remains.
- Run typecheck, lint, tests, production build, security audit, and
  unused-dependency audit.
- Compare client bundle output with the pre-removal baseline.
- Re-run all legacy fixture, asset, export, viewer, and critical workflow tests.
- Perform the final accessibility, performance, and mobile checks.
- Verify a clean install from the regenerated lockfile.

## Exit criteria

- `@excalidraw/excalidraw` is absent from `package.json` and
  `pnpm-lock.yaml`.
- Drawstuff owns the editor API, document format, renderer, input system, and
  product UI.
- Supported existing scenes remain readable through the runtime-free importer.
- The required checks and critical workflow tests pass.
- Bundle and audit results contain no unexplained regression.

## Rollback

Revert the removal change as a unit and restore the lockfile. Do not roll back
stored owned documents; use the already tested Phase 5H recovery path.
