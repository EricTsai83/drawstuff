# select

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Select.

## Changed

- `src/components/ui/select.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Select composition.
- `src/components/excalidraw/app-language/language-selector.tsx`: removed the obsolete custom trigger-icon prop and now uses the stock Nova icon.
- `.migration/select.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/select.tsx` returns no matches.

## Left alone

- The language selector retains controlled open state, item metadata, nullable-value handling, and propagation guards.

## Behavior changes

- Select now uses Nova's item-aligned default, width, spacing, scroll arrows, and stock chevron.

## Verify by hand

- Open the language selector and choose a language.
- Confirm the selected label, keyboard navigation, typeahead, Escape, and scroll arrows work.
- Check popup placement at desktop and mobile widths.
