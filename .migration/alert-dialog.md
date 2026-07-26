# alert-dialog

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Alert Dialog.

## Changed

- `src/components/ui/alert-dialog.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Alert Dialog implementation.
- Adopted Nova popup sizing, media/header/footer composition, transition states, and Base UI button rendering.
- `.migration/alert-dialog.md`: replaced the legacy `new-york` report with this Base Nova result.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/alert-dialog.tsx` returns no matches.

## Left alone

- Excalidraw's transitive Radix packages are third-party internals and were not modified.

## Behavior changes

- Dialog sizing, spacing, border treatment, and action layout now follow the stock Nova style.

## Verify by hand

- Open a destructive confirmation and confirm focus is trapped and restored.
- Confirm Cancel, Escape, and the destructive action behave correctly.
- Check the default and small layouts on desktop and mobile widths.
