# tooltip

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to Base UI Tooltip.

## Changed

- `src/components/ui/tooltip.tsx:4` replaces Radix Tooltip with `@base-ui/react/tooltip`.
- Provider `delayDuration` maps to `delay`; Content now uses `Portal > Positioner > Popup`, forwards all four positioning props, maps transform-origin, and uses Base UI transition hooks.
- `src/components/scene-card.tsx`, `src/components/overflow-tooltip.tsx`, and `src/components/excalidraw/workspace-settings-dialog.tsx` move delay to TooltipTrigger and replace `asChild` with Base UI `render`.
- `.migration/tooltip.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/tooltip.tsx` returns no matches.

## Left alone

- Existing tooltip color variants and their semantic token classes are preserved.

## Behavior changes

- Base UI Portal renders a wrapper element in its portal container.
- Base UI trigger delays are configured per Trigger rather than on Root; current consumer timing values were preserved.

## Verify by hand

1. Hover and keyboard-focus the scene title, info icon, and disabled-delete explanation.
2. Confirm each delay, color variant, side, arrow color, and offset feels unchanged.
3. Move the pointer from trigger to popup and confirm expected dismissal timing.
