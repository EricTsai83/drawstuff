# form

2026-07-26, golden reference via fresh shadcn Base Nova form guidance, migrated successfully from the removed legacy Form wrapper to the current Field pattern.

## Changed

- Removed `src/components/ui/form.tsx`; the current shadcn registry no longer provides the legacy React Hook Form adapter.
- Added `src/components/ui/field.tsx` and `src/components/ui/separator.tsx` from the official `base-nova` registry.
- `src/components/excalidraw/new-scene-dialog.tsx`: migrated to React Hook Form `Controller` with `Field`, `FieldGroup`, `FieldSet`, and `FieldError`.
- `src/components/excalidraw/scene-cloud-upload-dialog.tsx`: migrated controlled inputs and validation messages to `Controller` and `Field`.
- `src/components/excalidraw/workspace-settings-dialog.tsx`: migrated workspace-name validation to `Controller` and `Field`.
- `.migration/form.md`: replaced the legacy wrapper report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/field.tsx src/components/ui/separator.tsx` returns no matches.

## Left alone

- Existing Zod schemas, submit handlers, async mutations, and React Hook Form settings remain unchanged.

## Behavior changes

- Validation styling now uses `data-invalid` on `Field` and `aria-invalid` on controls.
- Field spacing and radio layout now follow Nova's current accessible form composition.

## Verify by hand

- Submit each migrated form with invalid values and confirm errors are announced and displayed.
- Submit valid create-scene, cloud-save, and workspace-rename forms.
- Confirm radio selection and focus order in the new-scene dialog.
