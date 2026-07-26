# Phase 4: Major Upgrades

## Goal

Handle major-version upgrades one at a time, with explicit compatibility and
rollback testing.

## Candidate upgrades

| Package | Current | Candidate | Decision |
| --- | --- | --- | --- |
| `eslint` | `9.39.4` | `10.8.0` | Upgrade separately |
| `lucide-react` | `0.555.0` | `1.27.0` | Upgrade with visual verification |
| `pako` | `2.1.0` | `3.0.1` | Upgrade with legacy scene fixtures |
| `nanoid` | `5.1.7` | `6.0.0` | Defer until Node 22+ is pinned everywhere |
| `pnpm` | `10.15.1` | `11.17.0` | Upgrade after application dependencies |
| `typescript` | `6.0.x` | `7.x` | Defer until tooling support is ready |
| `@types/node` | `24.x` | `26.x` | Keep aligned with deployed Node instead |

Registry versions must be refreshed when this phase begins.

## ESLint 10

- Confirm `eslint-config-next`, `typescript-eslint`, and
  `eslint-plugin-drizzle` support ESLint 10.
- Upgrade ESLint without changing rule configuration first.
- Review new or changed diagnostics in a follow-up commit.
- Do not disable typed rules merely to make the upgrade pass.

## Lucide React 1

- Run typecheck to find renamed or removed icons.
- Compare icon size, stroke width, alignment, and accessibility labels.
- Visually inspect toolbars, menus, cards, dialogs, and authentication screens.

## Pako 3

This upgrade touches persisted scene data and therefore requires special care.

- Confirm `deflate` and `inflate` imports and return types.
- Use production-like compressed scene fixtures.
- Verify new code can open existing data.
- Verify data written by the new version can be reopened.
- Check browser and server execution paths.
- Remove `@types/pako` if Pako 3's bundled declarations cover all imports.

Do not combine this upgrade with the new whiteboard document migration.

## Nanoid 6

- Confirm local, CI, and Vercel Node versions meet Nanoid's engine requirement.
- Review ESM imports.
- Verify ID generation paths and database constraints.
- This is low priority because the current direct Nanoid 5 version is already
  outside the affected vulnerable range found during the audit.

## pnpm 11

- Upgrade only after application and tooling packages are stable.
- Update `packageManager` and Corepack configuration together.
- Recreate the lockfile only when required by the new lockfile format.
- Compare dependency resolution and peer warnings before merging.

## TypeScript 7 readiness gate

Adopt TypeScript 7 only when:

- typescript-eslint officially supports the chosen setup, or the project adopts
  the official side-by-side TypeScript 6 compatibility arrangement.
- Next.js type tooling and editor integration have been tested.
- TypeScript 6 builds without deprecation suppression.
- CI and local editors produce consistent diagnostics.

## Verification

Every candidate is its own branch or pull request and must pass:

```bash
pnpm typecheck
pnpm lint
SKIP_ENV_VALIDATION=1 pnpm build
```

Run the package-specific tests above before merging.

## Exit criteria

- Each accepted major upgrade is independently verified.
- Deferred upgrades have an explicit readiness condition.
- Runtime types remain aligned with the deployed Node version.
- Existing scene data remains readable.

