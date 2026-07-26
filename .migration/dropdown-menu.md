# dropdown-menu

2026-07-26, transformation engine for heavily customized legacy `new-york`, migrated successfully from Radix Dropdown Menu to Base UI Menu.

## Changed

- `src/components/ui/dropdown-menu.tsx`: replaced Radix Dropdown Menu primitives with Base UI Menu primitives.
- Rebuilt popup positioning with `Portal`, `Positioner`, and `Popup`, including Base UI collision variables and transition hooks.
- Mapped labels to `GroupLabel`, indicators to Base UI checkbox/radio indicators, and submenu primitives to `SubmenuRoot` and `SubmenuTrigger`.
- Reused the public content wrapper for submenu content so both menu levels share positioning and animation behavior.
- Updated menu triggers from `asChild` to Base UI `render`, and changed menu item activation handlers from Radix `onSelect` to `onClick`.
- Added this migration report.
- Direct Radix imports and Radix CSS variables for this component were removed.

## Left alone

- `cmdk` `CommandItem` `onSelect` handlers and Excalidraw `MainMenu` handlers are unrelated third-party APIs and were not changed.

## Behavior changes

- Base UI checkbox and radio menu items remain open after activation by default; there are currently no consumers of those wrappers, so no close override was added.
- Base UI owns menu focus looping and popup portal behavior.

## Verify by hand

- Open a scene card menu and confirm import, edit, publish, link, and delete actions fire once.
- Open the move-to-workspace submenu and confirm it appears beside the parent menu and remains scrollable.
- Open the dashboard workspace settings menu and confirm create, rename, and delete dialogs open.
- Navigate both menu levels with arrow keys, Escape, Enter, and Space.
