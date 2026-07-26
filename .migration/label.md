# label

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully from Radix Label to a native label.

## Changed

- `src/components/ui/label.tsx:3` removes `@radix-ui/react-label` and renders a native `<label>` with the existing classes and props.
- `.migration/label.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/label.tsx` returns no matches.

## Left alone

- Label consumers already use standard `htmlFor` and native label props, so no call-site changes were needed.

## Behavior changes

- Radix prevented text selection on double-click; the existing `select-none` class preserves that behavior on the native label.

## Verify by hand

1. Click labels in dialog forms and confirm their associated input or radio receives focus.
2. Double-click label text and confirm it is not selected.
