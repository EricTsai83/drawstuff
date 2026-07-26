# avatar

2026-07-26, golden reference via a fresh shadcn Base Nova project and CLI replay, migrated successfully to the stock Base Nova Avatar.

## Changed

- `src/components/ui/avatar.tsx`: replaced the legacy-styled wrapper with the official `base-nova` Avatar implementation.
- Added Nova size variants, badge support, fallback layering, and image-loading transitions.
- `.migration/avatar.md`: replaced the previous transformation-engine report.
- The leftover scan is clean: `grep -n "radix-ui\|@radix-ui" src/components/ui/avatar.tsx` returns no matches.

## Left alone

- Existing avatar consumers keep their current image and fallback values.

## Behavior changes

- Avatar dimensions and fallback presentation now follow Nova size variants.

## Verify by hand

- Load an avatar successfully and confirm the image fills the frame.
- Test a broken image and confirm the fallback remains visible.
- Check any avatar badge at supported sizes.
