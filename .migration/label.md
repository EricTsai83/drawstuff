# label

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Label.

## Changed

- `src/components/ui/label.tsx`: aligned with the official `base-nova` Label implementation and disabled-state selectors.
- `.migration/label.md`: replaced the previous native-label report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/label.tsx` returns no matches.

## Left alone

- Native labels outside the shadcn wrapper remain native markup.

## Behavior changes

- Label spacing and disabled-state styling now follow Nova.

## Verify by hand

- Click labels for text, textarea, and radio controls and confirm focus or selection moves correctly.
- Confirm disabled labels display reduced opacity.
