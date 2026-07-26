# Phase 4: Major Upgrades

## Goal

Handle major-version upgrades one at a time, with explicit compatibility and
rollback testing.

## Candidate upgrades

Registry versions were refreshed on 2026-07-26.

| Package | Starting | Candidate | Outcome |
| --- | --- | --- | --- |
| `eslint` | `9.39.4` | `10.8.0` | Deferred: the Next.js plugin stack still rejects or crashes on ESLint 10 |
| `lucide-react` | `0.555.0` | `1.27.0` | Upgraded; the removed GitHub brand icon now uses the existing local icon |
| `pako` | `2.1.0` | `3.0.1` | Upgraded with browser, server, legacy-read, and new-write coverage |
| `nanoid` | `5.1.7` | `6.0.0` | Upgraded after confirming Node 24 across local, CI, and deployment config |
| `pnpm` | `10.15.1` | `11.17.0` | Upgraded after the application dependency checks passed |
| `typescript` | `6.0.x` | `7.0.2` | Deferred: `typescript-eslint@8.65.0` requires TypeScript `<6.1.0` |
| `@types/node` | `24.x` | `26.x` | Kept on 24 to match the deployed Node major |

## ESLint 10

- Confirm `eslint-config-next`, `typescript-eslint`, and
  `eslint-plugin-drizzle` support ESLint 10.
- Upgrade ESLint without changing rule configuration first.
- Review new or changed diagnostics in a follow-up commit.
- Do not disable typed rules merely to make the upgrade pass.

The 2026-07-26 compatibility check found that `eslint-config-next@16.2.12`
declares `eslint >=9`, but its `eslint-plugin-import`, `eslint-plugin-react`,
`eslint-plugin-react-hooks`, and `eslint-plugin-jsx-a11y` dependencies do not
accept ESLint 10. The current config also fails at runtime with
`scopeManager.addGlobals is not a function`. Retry only after the complete
Next.js plugin stack declares and passes ESLint 10 support.

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

The readiness condition is now satisfied: `.node-version`, `engines.node`, and
the CI workflow all use Node 24, which meets Nanoid 6's
`^22 || ^24 || >=26` engine requirement.

## pnpm 11

- Upgrade only after application and tooling packages are stable.
- Update `packageManager` and Corepack configuration together.
- Recreate the lockfile only when required by the new lockfile format.
- Compare dependency resolution and peer warnings before merging.

pnpm 11 retained the existing lockfile format. `pnpm-workspace.yaml` keeps the
previously blocked `esbuild`, `msgpackr-extract`, `sharp`, and `unrs-resolver`
install scripts explicitly disabled, and carries forward the ESLint and
Prettier public-hoist patterns that pnpm 11 no longer reads from `.npmrc`. It
also pins `enableGlobalVirtualStore: false` so local and CI installs use the
same project-local dependency layout. CI passes `--trust-lockfile` because the
committed lockfile is its reviewed dependency baseline, while local installs
continue to enforce pnpm 11's release-age policy.

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
