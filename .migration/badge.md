# badge

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Badge.

## Changed

- `src/components/ui/badge.tsx`: replaced the legacy style with the official `base-nova` Badge variants and Base UI rendering.
- `.migration/badge.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/badge.tsx` returns no matches.

## Left alone

- Existing badge labels and semantic variants remain unchanged.

## Behavior changes

- Badge height, radius, padding, and focus treatment now follow Nova.

## Verify by hand

- Check default, secondary, destructive, and outline badges.
- Confirm long labels remain on one line without overflowing their container.
