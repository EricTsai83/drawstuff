# popover

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to Base UI Popover.

## Changed

- `src/components/ui/popover.tsx:4` replaces Radix Popover with `@base-ui/react/popover`.
- PopoverContent now uses `Portal > Positioner > Popup`, explicitly forwards alignment, side, offsets, and collision padding, rewrites animations to Base UI transition hooks, and maps the transform-origin variable.
- `src/components/workspace-dropdown.tsx` maps the anchor-width CSS variable to Base UI's `--anchor-width`.
- `.migration/popover.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/popover.tsx` returns no matches.

## Left alone

- The cmdk Command inside the workspace popover remains intentionally untouched because cmdk is not Radix.

## Behavior changes

- Base UI has no Popover Anchor part. The exported `PopoverAnchor` is retained as an inert span passthrough; there are no current consumers.
- Base UI Portal renders a wrapper element in its portal container.

## Verify by hand

1. Open the workspace selector and confirm its width aligns to the trigger.
2. Exercise search, keyboard navigation, outside click, Escape, and focus return.
3. Check collision behavior near viewport edges.
