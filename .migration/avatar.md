# avatar

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to Base UI Avatar.

## Changed

- `src/components/ui/avatar.tsx:4` replaces `@radix-ui/react-avatar` with `@base-ui/react/avatar` and updates each part to Base UI prop types.
- `.migration/avatar.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/avatar.tsx` returns no matches.

## Left alone

- `src/components/avatar.tsx` uses only compatible Root, Image, and Fallback props, so no consumer changes were necessary.

## Behavior changes

- Base UI renames the optional Fallback `delayMs` prop to `delay`; no current consumer uses either prop.

## Verify by hand

1. Open the account/avatar UI with a valid image and confirm it is cropped and rounded correctly.
2. Use a broken image URL and confirm the fallback appears with the expected initials and colors.
