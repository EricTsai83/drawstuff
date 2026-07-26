# popover

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Popover.

## Changed

- `src/components/ui/popover.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Popover composition.
- Added stock `PopoverHeader`, `PopoverTitle`, and `PopoverDescription` exports.
- `src/components/workspace-dropdown.tsx`: removed the obsolete custom collision-padding prop.
- `.migration/popover.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/popover.tsx` returns no matches.

## Left alone

- The workspace popover retains its `data-prevent-outside-click` marker for drawstuff's own outside-click hook.

## Behavior changes

- Popup size, surface, ring, spacing, and collision defaults now follow Nova.

## Verify by hand

- Open the workspace selector near each viewport edge.
- Confirm search, selection, creation, outside click, and Escape work.
- Check popup width and dark-mode surface treatment.
