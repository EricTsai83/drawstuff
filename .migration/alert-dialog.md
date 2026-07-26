# alert-dialog

2026-07-26, transformation engine for legacy `new-york` style, migrated successfully to Base UI while preserving the existing visual classes.

## Changed

- `src/components/ui/alert-dialog.tsx:4` now uses `@base-ui/react/alert-dialog` and the Base UI button primitive.
- `src/components/ui/alert-dialog.tsx:29` maps Radix `Overlay` to Base UI `Backdrop`; `src/components/ui/alert-dialog.tsx:45` maps `Content` to the centered `Popup` shape and rewrites state animations to Base UI starting/ending transition hooks.
- `src/components/ui/alert-dialog.tsx:116` replaces the removed Radix `Action` primitive with a styled Base UI button; `src/components/ui/alert-dialog.tsx:128` maps `Cancel` to Base UI `Close`.
- `package.json:21` and `pnpm-lock.yaml` add `@base-ui/react@1.6.0` alongside Radix for the progressive migration.
- `.migration/alert-dialog.md` records the migration and manual QA checklist.
- The required leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/alert-dialog.tsx` returns no matches.

## Left alone

- `src/components/confirm-dialog.tsx` and `src/components/scene-card.tsx` use only compatible wrapper props, so their final call sites and imports remain unchanged.
- `src/components/ui/button.tsx` remains on Radix Slot; Alert Dialog reuses only its `buttonVariants` style definition and uses Base UI for the actual action button.
- `components.json` remains on legacy `new-york`/Radix configuration during this progressive migration. Future shadcn additions will remain Radix-based until the last wrapper is migrated.
- Existing Radix dependencies, including `@radix-ui/react-alert-dialog`, remain installed until the project's final Radix wrapper is migrated, as required by the progressive migration workflow.

## Behavior changes

- `AlertDialogAction` is now a plain Base UI button because Base UI has no Action part; unlike Radix Action, it does not implicitly close the dialog. Both current consumers already control `open` and close explicitly after their async confirmation work.
- Base UI `onOpenChange` supplies a second event-details argument. The current single-argument handlers remain compatible.
- Base UI Portal renders a wrapper element in the portal container, whereas Radix Portal did not.

## Verify by hand

1. Open the global workspace confirmation and scene-delete confirmation; confirm the overlay and popup animate without a visual jump.
2. Confirm focus starts on Cancel, Tab remains trapped inside the dialog, Escape closes it, and an outside click does not close it.
3. Confirm Cancel closes and restores focus. Confirm the destructive action stays open while disabled/loading and closes after the existing async success path.
4. Confirm destructive and outline button styling still matches the previous dialogs.
