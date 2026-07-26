# tooltip

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Tooltip.

## Changed

- `src/components/ui/tooltip.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Tooltip implementation.
- `src/app/layout.tsx`: added the stock global `TooltipProvider`.
- `src/components/overflow-tooltip.tsx`, `src/components/scene-card.tsx`, and `src/components/excalidraw/workspace-settings-dialog.tsx`: removed the obsolete custom tooltip variant API.
- `.migration/tooltip.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/tooltip.tsx` returns no matches.

## Left alone

- `OverflowTooltip` retains overflow detection, delay compatibility, offset, and custom layout classes.

## Behavior changes

- Tooltips now use one stock Nova foreground surface and arrow instead of project-specific color variants.
- A single provider at the app shell now owns tooltip coordination.

## Verify by hand

- Hover scene names, descriptions, and disabled workspace actions.
- Confirm overflow-only display, delays, offsets, Escape dismissal, and arrow placement.
- Check light and dark mode contrast.
