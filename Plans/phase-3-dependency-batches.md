# Phase 3: Same-Major Dependency Batches

## Goal

Upgrade compatible same-major dependencies in functional groups, remove unused
packages, and keep regressions attributable to a small batch.

## Batch A: API and server state

| Package | Current | Target |
| --- | --- | --- |
| `@trpc/client` | `11.13.4` | `11.18.0` |
| `@trpc/react-query` | `11.13.4` | `11.18.0` |
| `@trpc/server` | `11.13.4` | `11.18.0` |
| `@tanstack/react-query` | `5.91.2` | `5.101.4` |

Upgrade all three tRPC packages together.

Verify query hydration, mutations, error serialization, authentication context,
and cache invalidation.

## Batch B: Forms and validation

| Package | Current | Target |
| --- | --- | --- |
| `react-hook-form` | `7.71.2` | `7.83.0` |
| `@hookform/resolvers` | `5.2.2` | `5.5.4` |
| `zod` | `4.3.6` | `4.4.3` |

Verify login forms, scene dialogs, workspace dialogs, validation messages, and
server-side schema parsing.

## Batch C: Tailwind and formatting

| Package | Current | Target |
| --- | --- | --- |
| `tailwindcss` | `4.2.2` | `4.3.3` |
| `@tailwindcss/postcss` | `4.2.2` | `4.3.3` |
| `tailwind-merge` | `3.5.0` | `3.6.0` |
| `prettier` | `3.8.1` | `3.9.6` |
| `prettier-plugin-tailwindcss` | `0.7.2` | `0.8.1` |

Verify all primary pages in light and dark mode. Run the format check before
accepting formatting changes; keep a purely mechanical formatting commit
separate if the output changes substantially.

## Batch D: General updates

| Package | Current | Target |
| --- | --- | --- |
| `date-fns` | `4.1.0` | `4.4.0` |
| `nuqs` | `2.8.9` | `2.9.2` |
| `postgres` | `3.4.8` | `3.4.9` |
| `@t3-oss/env-nextjs` | `0.13.10` | `0.13.11` |
| `use-debounce` | `10.1.0` | remove |
| `idb-keyval` | `6.2.2` | remove |

Review the newest registry versions again immediately before execution.

## Dependency cleanup

Remove after confirming no hidden scripts use them:

- `idb-keyval`
- `use-debounce`
- `@eslint/eslintrc`
- `baseline-browser-mapping`

The project uses its own `@/hooks/use-debounce`, not the external
`use-debounce` package.

`shadcn` is a development CLI and should not be a production dependency.
Prefer removing it and invoking a pinned version through `pnpm dlx`, or move it
to `devDependencies` if local installation is required.

## Verification

Run the standard checks after each batch. Additionally:

- API batch: test tRPC calls and optimistic/cache behavior.
- Forms batch: test all form submit, reset, and error states.
- CSS batch: visually inspect editor, dashboard, dialogs, menus, and mobile
  layouts.
- General batch: test URL state, relative timestamps, database connections, and
  environment parsing.

## Rollback

Each batch must be independently revertible with its matching lockfile changes.
Do not combine formatting output with a functional package update when it would
obscure the functional diff.

## Exit criteria

- All approved same-major updates are complete.
- Unused dependencies are removed.
- `shadcn` is no longer a production runtime dependency.
- No new peer-dependency warnings are present.

