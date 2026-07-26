# Drawstuff Modernization Plans

This directory contains the phased plan for dependency modernization and the
eventual replacement of `@excalidraw/excalidraw`.

## Execution order

| Phase | Plan | Outcome |
| --- | --- | --- |
| 0 | [Upgrade safety net](./phase-0-upgrade-safety-net.md) | CI and runtime baselines make later upgrades safe |
| 1 | [Security patches](./phase-1-security-patches.md) | Known direct-dependency vulnerabilities are patched |
| 2 | [TypeScript 6](./phase-2-typescript-6.md) | The project uses the latest supported TypeScript toolchain |
| 3 | [Dependency batches](./phase-3-dependency-batches.md) | Same-major dependencies are upgraded in compatible groups |
| 4 | [Major upgrades](./phase-4-major-upgrades.md) | Riskier major upgrades are handled one at a time |
| 5 | [Whiteboard replacement](./phase-5-whiteboard-replacement.md) | Excalidraw is replaced by an owned whiteboard component |

## Global rules

- Execute phases in order unless an urgent security fix must be expedited.
- Keep each independently testable batch in a separate branch or pull request.
- Do not combine dependency upgrades with unrelated product changes.
- Update `pnpm-lock.yaml` only through pnpm.
- Do not accept new TypeScript errors or ESLint errors.
- Preserve compatibility with existing saved and published scenes.
- Record any deliberate compatibility exception in the relevant phase plan.

## Required checks

Run these checks after every batch:

```bash
pnpm typecheck
pnpm lint
SKIP_ENV_VALIDATION=1 pnpm build
```

Also verify the user workflows listed in each plan before merging.

## Current baseline

Baseline captured on 2026-07-26:

- Node: `24.18.0`
- pnpm: `10.15.1`
- TypeScript: `5.9.3`
- React / React DOM: `19.2.4`
- Next.js: `16.2.0`
- Typecheck: passes
- Production build: passes
- Lint: passes with two warnings
- Next.js production builds currently skip type validation through
  `typescript.ignoreBuildErrors`.

