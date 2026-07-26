# radio-group

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to Base UI Radio Group and Radio primitives.

## Changed

- `src/components/ui/radio-group.tsx:3` replaces the combined Radix namespace with Base UI's split `RadioGroup` and `Radio` modules.
- `src/components/ui/radio-group.tsx:11` maps Radix Root to the callable Base UI RadioGroup; `src/components/ui/radio-group.tsx:25` maps Item and Indicator to `Radio.Root` and `Radio.Indicator`.
- Disabled classes now use Base UI's `data-disabled` hook because Radio.Root renders a generic element.
- `.migration/radio-group.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/radio-group.tsx` returns no matches.

## Left alone

- The new-scene form uses compatible string values and single-argument handlers, so no call-site changes were necessary.

## Behavior changes

- Base UI automatically supports arrow-key navigation in both axes and does not expose Radix's `orientation` or configurable `loop` props; current consumers did not set them.

## Verify by hand

1. Open the new-scene dialog and focus the content-mode radio group.
2. Use arrow keys to change selection and confirm the visible indicator follows.
3. Submit each selection and confirm the chosen mode is preserved.
