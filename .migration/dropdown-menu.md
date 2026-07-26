# dropdown-menu

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Dropdown Menu.

## Changed

- `src/components/ui/dropdown-menu.tsx`: replaced the legacy-styled menu with the official `base-nova` Base UI Menu composition.
- Adopted Nova popup, submenu, group, checkbox, radio, label, shortcut, and indicator anatomy.
- `.migration/dropdown-menu.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/dropdown-menu.tsx` returns no matches.

## Left alone

- `cmdk` `CommandItem` and Excalidraw `MainMenu` APIs are unrelated third-party components and were not rewritten.

## Behavior changes

- Menu sizing, spacing, destructive states, indicators, and submenu positioning now follow Nova.
- Base UI checkbox and radio items remain open after activation by default.

## Verify by hand

- Open scene-card and workspace menus and activate each action.
- Navigate menu items and submenus with arrow keys, Enter, Space, and Escape.
- Confirm submenu placement and long workspace scrolling.
