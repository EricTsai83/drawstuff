# radio-group

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Radio Group.

## Changed

- `src/components/ui/radio-group.tsx`: aligned with the official `base-nova` Radio Group and Radio implementation.
- `src/components/excalidraw/new-scene-dialog.tsx`: placed radio options in the current `FieldSet` and `FieldGroup` form anatomy.
- `.migration/radio-group.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/radio-group.tsx` returns no matches.

## Left alone

- The new-scene content-mode values and submit behavior remain unchanged.

## Behavior changes

- Radio dimensions, border, selected indicator, focus ring, and disabled states now follow Nova.

## Verify by hand

- Select both new-scene content options by mouse and keyboard.
- Confirm arrow-key navigation and validation state are correct.
