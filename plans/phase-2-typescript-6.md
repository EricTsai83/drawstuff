# Phase 2: TypeScript 6

## Goal

Move from TypeScript `5.9.3` to `6.0.3`, the newest version currently supported
by the project's typed ESLint tooling, and prepare the codebase for TypeScript
7.

## Why not TypeScript 7 yet

TypeScript 7.0 is the newest compiler, but its initial release does not expose
the complete compiler API expected by tools such as `typescript-eslint`.
`typescript-eslint@8.65.0` officially supports TypeScript versions below `6.1`.

TypeScript 7 can be evaluated separately, but it should not become the primary
toolchain until Next.js, editor tooling, and typed ESLint have an agreed support
path.

## Target versions

| Package | Current | Target |
| --- | --- | --- |
| `typescript` | `5.9.3` | `6.0.3` |
| `typescript-eslint` | `8.57.1` | `8.65.0` |
| `@types/node` | `24.12.0` | latest `24.x` |

Keep ESLint on version 9 during this phase.

## Tasks

### 1. Upgrade compiler and typed linting

- Update TypeScript and typescript-eslint together.
- Do not update ESLint to version 10 in the same batch.
- Regenerate the pnpm lockfile.

### 2. Review `tsconfig.json`

- Add an explicit `types` array when required, normally including `node`.
- Keep `module: "ESNext"` and `moduleResolution: "Bundler"`.
- Keep the explicit `target` and `lib` values.
- Review whether `dom.iterable` can be removed because TypeScript 6 includes it
  in the DOM library.
- Do not add `ignoreDeprecations` as a permanent solution.

### 3. Resolve migration diagnostics

- Fix all new compiler errors.
- Resolve TypeScript 6 deprecation warnings.
- Pay special attention to JavaScript files because `allowJs` and `checkJs` are
  enabled.
- Verify dependency declaration files with and without `skipLibCheck` during
  investigation, while retaining the existing production setting unless a
  deliberate change is approved.

### 4. Measure and record

Record before/after values for:

- Cold `pnpm typecheck`.
- Incremental `pnpm typecheck`.
- Editor diagnostics startup, if practical.

This becomes the comparison baseline for a future TypeScript 7 pilot.

## Verification

```bash
pnpm typecheck
pnpm lint
SKIP_ENV_VALIDATION=1 pnpm build
```

Also validate Drizzle config, Next.js generated types, tRPC inference, Zod
schemas, React JSX types, and Excalidraw declaration files.

## Optional TypeScript 7 pilot

After TypeScript 6 is clean:

- Run TypeScript 7 in a non-blocking CI experiment.
- Do not replace the supported TypeScript 6 toolchain.
- Compare diagnostics and performance.
- Track TypeScript 7.1 and typescript-eslint support.

## Rollback

Revert TypeScript, typescript-eslint, tsconfig, and lockfile changes together.
Do not suppress new diagnostics globally to preserve the upgrade.

## Exit criteria

- TypeScript `6.0.3` is the primary compiler.
- No TypeScript 6 deprecation suppressions are required.
- Typed ESLint, Next.js build, and editor types work.
- The project is structurally ready for TypeScript 7.

