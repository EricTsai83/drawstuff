# select

2026-07-26, transformation engine for heavily customized legacy `new-york`, migrated successfully from Radix Select to Base UI Select.

## Changed

- `src/components/ui/select.tsx`: replaced Radix Select primitives with Base UI Select primitives.
- Rebuilt popup positioning with `Portal`, `Positioner`, `Popup`, and `List`, preserving the wrapper's popper-style default placement.
- Converted Radix collision CSS variables and animation state selectors to Base UI variables and transition hooks.
- Mapped labels to `GroupLabel`, scroll controls to `ScrollUpArrow` and `ScrollDownArrow`, and item anatomy to `ItemText` followed by `ItemIndicator`.
- Converted the custom trigger icon from `asChild` composition to Base UI `render`.
- Updated the language selector to supply Base UI item metadata, handle its nullable value callback, and place its accessible label on the trigger.
- Added this migration report.
- Direct Radix imports and Radix CSS variables for this component were removed.

## Left alone

- The language selector's controlled open state, custom dropdown icon, and click-propagation guards remain unchanged.

## Behavior changes

- Base UI now resolves the selected value label from the supplied item metadata.
- The select wrapper retains popper-style positioning by default with item-to-trigger alignment disabled, matching its previous Radix default.

## Verify by hand

- Open the Excalidraw language selector and confirm the popup width and placement match the trigger.
- Select a language and confirm the visible label and application language update.
- Confirm the custom chevron rotates when the popup opens and closes.
- Navigate the list with arrow keys, Home, End, Enter, Escape, and typeahead.
