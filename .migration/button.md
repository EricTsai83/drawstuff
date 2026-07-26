# button

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Button.

## Changed

- `src/components/ui/button.tsx`: replaced the legacy-styled Base UI wrapper with the official `base-nova` Button implementation.
- Adopted Nova variants, eight stock sizes, icon-aware padding, and active/focus states.
- `.migration/button.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/button.tsx` returns no matches.

## Left alone

- Existing link consumers continue using Base UI `render` and `nativeButton={false}`.

## Behavior changes

- Default buttons are now Nova's compact 32px height; other sizes and destructive styling also follow Nova.

## Verify by hand

- Check all button variants in light and dark mode.
- Activate link-rendered buttons and confirm navigation occurs once.
- Confirm disabled, loading, keyboard-focus, and icon-only buttons remain accessible.
