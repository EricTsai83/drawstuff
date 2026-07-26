# Project Radix to Base UI migration

2026-07-26, completed the project-wide migration of first-party React UI wrappers from Radix UI to Base UI.

## Result

- Migrated all 12 affected first-party wrappers: alert dialog, avatar, badge, button, dialog, dropdown menu, form, label, popover, radio group, select, and tooltip.
- Updated wrapper consumers for Base UI composition, event, positioning, focus, and value APIs.
- Removed all 10 direct `@radix-ui/*` dependencies from `package.json` and refreshed `pnpm-lock.yaml`.
- First-party source files now contain zero direct Radix imports and zero Radix CSS custom properties.
- Added one component report per migrated wrapper under `.migration/`.

## Configuration

- `components.json` remains `style: "new-york"` because shadcn has no Base UI version of the legacy `new-york` style.
- This means future `shadcn` CLI additions can still generate Radix-based source and must be reviewed or manually transformed before merging.
- `@base-ui/react` remains the project's direct primitive dependency.

## Third-party dependencies

- Excalidraw still brings `@radix-ui/react-tabs` transitively. It is third-party implementation detail, not a first-party wrapper or direct project dependency, and was intentionally left untouched.
- `cmdk`, Sonner, and Excalidraw-specific component APIs were not rewritten where they only resembled Radix APIs.

## Verification

- Run `pnpm typecheck`.
- Run `pnpm lint`.
- Run `pnpm build`.
- Search `src` and `package.json` for direct `@radix-ui` imports or dependencies.
- Search first-party source for `--radix-`, obsolete `asChild`, and Radix state selectors.
- Manually execute the verification checklist in each component report.
