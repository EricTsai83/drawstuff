# button

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to the Base UI Button primitive.

## Changed

- `src/components/ui/button.tsx:2` replaces Radix Slot with `@base-ui/react/button` while preserving all existing variants and classes.
- `src/app/not-found.tsx` and `src/components/error-page.tsx` replace `asChild` link composition with Base UI `render` and `nativeButton={false}`.
- `.migration/button.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/button.tsx` returns no matches.

## Left alone

- Other UI wrappers remain unchanged in this component commit and are migrated separately in dependency order.

## Behavior changes

None for current consumers. Polymorphic Button composition now uses Base UI's `render` prop instead of Radix `asChild`.

## Verify by hand

1. Open the not-found and error pages and activate both navigation buttons.
2. Confirm the links keep button styling and navigate only once.
3. Keyboard-focus each link and confirm Enter activates it.
