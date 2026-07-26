# Project Radix to Base UI migration

2026-07-26, completed the project-wide migration by replaying a fresh official Next.js + Base UI + Nova shadcn project as the golden reference.

## Result

- Created a temporary reference project with `shadcn create --template next --preset nova --base base`.
- Drawstuff and the reference now resolve to the same shadcn preset code, `b2fA`.
- `components.json` now reports `style: "base-nova"` and `base: "base"`.
- Replayed the complete stock Base Nova implementations for all installed shadcn components.
- Added the current `field`, `input-group`, and `separator` components.
- Removed the retired legacy `form.tsx` wrapper and migrated all three React Hook Form consumers to `Controller` plus `Field`.
- Aligned the app shell with the fresh scaffold's Geist fonts, theme provider, global tooltip provider, neutral theme, radius scale, and `shadcn/tailwind.css`.
- Removed all direct `@radix-ui/*` dependencies. First-party source contains zero Radix imports, Radix CSS variables, obsolete `asChild`, or Radix state selectors.

## Configuration

- Future `pnpm dlx shadcn@latest add ...` commands now resolve Base UI variants automatically.
- The installed shadcn state matches the fresh reference: `base-nova`, Base UI, neutral palette, Geist, Lucide, subtle menu accent, and default menu color.
- `@base-ui/react` and `shadcn` are direct dependencies, matching the generated reference project.
- Drawstuff retains its existing code-format convention; stock components were formatted equivalently instead of adopting the scaffold's repository-wide Prettier settings.

## Third-party dependencies

- Excalidraw `0.18.0` still brings `@radix-ui/react-tabs` and `@radix-ui/react-popover` transitively. They are required third-party internals and were intentionally retained.
- `cmdk`, Sonner, and Excalidraw-specific APIs remain on their own supported libraries.

## Verification

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with two pre-existing warnings and zero errors.
- `pnpm build`: passed.
- `pnpm dlx shadcn@latest info --json`: reports `base-nova`, `base`, and preset code `b2fA`, matching the fresh reference project.
- First-party Radix and legacy Form leftover scans: clean.
- In-app browser: the login page renders successfully with the Base Nova shell and no component runtime errors. Authenticated dashboard interaction requires an authenticated browser session.
- Manual family-specific checks remain listed in each component report.
