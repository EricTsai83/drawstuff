# dialog

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Dialog.

## Changed

- `src/components/ui/dialog.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Dialog implementation.
- Adopted Nova overlay, popup, header/footer, close button, and transition structure.
- `.migration/dialog.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/dialog.tsx` returns no matches.

## Left alone

- Drawstuff dialogs retain their controlled state, async actions, and Base UI dismissal props.
- Excalidraw itself remains an untouched third-party dependency.

## Behavior changes

- Dialog dimensions, spacing, close affordance, and surface treatment now follow Nova.

## Verify by hand

- Open create, rename, edit, share, conflict, and workspace dialogs.
- Confirm focus starts correctly, Tab stays inside, and focus returns on close.
- Confirm protected dialogs do not dismiss during their loading state.
