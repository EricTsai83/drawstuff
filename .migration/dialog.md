# dialog

2026-07-26, transformation engine for customized legacy `new-york`, migrated successfully to Base UI Dialog.

## Changed

- `src/components/ui/dialog.tsx:4` replaces Radix Dialog with `@base-ui/react/dialog`.
- Overlay maps to `Backdrop`, Content maps to centered `Popup`, and state animations use Base UI starting/ending transition hooks.
- `src/components/scene-share-dialog.tsx`, `src/components/scene-edit-dialog.tsx`, `src/components/excalidraw/scene-cloud-upload-dialog.tsx`, `new-scene-dialog.tsx`, `workspace-settings-dialog.tsx`, and `scene-rename-dialog.tsx` replace Radix autofocus and dismissal callbacks with `initialFocus={false}`, default Base UI close behavior, and `disablePointerDismissal` where outside presses must remain blocked.
- `src/components/excalidraw/new-scene-dialog.tsx`, `workspace-settings-dialog.tsx`, and `scene-rename-dialog.tsx` replace DialogTrigger `asChild` with Base UI `render`.
- `src/components/excalidraw/scene-remote-conflict-dialog.tsx` cancels Base UI close event details while loading and disables pointer dismissal.
- `src/components/ui/command.tsx` narrows its composed Dialog children type to ReactNode so the intentionally untouched cmdk wrapper remains compatible with Base UI's payload-capable Dialog Root.
- `.migration/dialog.md` records the migration.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/dialog.tsx` returns no matches.

## Left alone

- `src/components/ui/command.tsx` remains a cmdk wrapper and was intentionally not migrated; it continues composing the public Dialog wrapper.

## Behavior changes

- Base UI `onOpenChange` adds event details; existing one-argument controlled handlers remain compatible.
- Base UI Portal renders a wrapper element in its portal container.

## Verify by hand

1. Open each dialog from a custom trigger and confirm focus, Escape close, outside-click behavior, and focus return.
2. Confirm scene-edit ignores outside presses while upload/share dialogs retain their intended dismissal behavior.
3. Confirm the close button, overlay, and popup transitions match the previous layout.
