# form

2026-07-26, transformation engine for the customized React Hook Form wrapper, removed its remaining Radix Label and Slot dependencies successfully.

## Changed

- `src/components/ui/form.tsx:4` replaces Radix Slot with Base UI `useRender` and `mergeProps`.
- `src/components/ui/form.tsx:91` types `FormLabel` against the migrated native Label wrapper.
- `src/components/ui/form.tsx:107` preserves the existing `<FormControl><Input /></FormControl>` API while merging accessibility props through Base UI rendering utilities; it also accepts Base UI's explicit `render` prop.
- `.migration/form.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/form.tsx` returns no matches.

## Left alone

- `Form`, `FormField`, and validation state remain powered by `react-hook-form`; this file is shadcn's React Hook Form adapter, not a Radix Form primitive wrapper.
- Existing form call sites remain unchanged because the wrapper preserves child composition.

## Behavior changes

None for current consumers. FormControl prop merging now uses Base UI's merge semantics.

## Verify by hand

1. Open create, rename, upload, and workspace-settings forms.
2. Submit invalid values and confirm labels, descriptions, messages, `aria-describedby`, and `aria-invalid` remain connected.
3. Enter valid values and confirm each form submits once.
