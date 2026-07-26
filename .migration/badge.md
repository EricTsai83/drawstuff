# badge

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully from Radix Slot to Base UI rendering utilities.

## Changed

- `src/components/ui/badge.tsx:1` replaces Radix Slot with Base UI `useRender` and `mergeProps`, preserving variants and classes.
- `.migration/badge.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/badge.tsx` returns no matches.

## Left alone

- Existing Badge consumers do not use `asChild`, so no call-site changes were necessary.

## Behavior changes

None for current consumers. Future polymorphic composition uses `render` instead of `asChild`.

## Verify by hand

1. Open the dashboard and inspect published, unpublished, and category badges.
2. Confirm colors, borders, spacing, and icon alignment match the previous UI.
