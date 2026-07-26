# Drawstuff Modernization Plans

This directory contains the phased plan for dependency modernization and the
eventual replacement of `@excalidraw/excalidraw`.

## Execution order

| Phase | Plan                                                                               | Outcome                                                        |
| ----- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0     | [Upgrade safety net](./phase-0-upgrade-safety-net.md)                              | CI and runtime baselines make later upgrades safe              |
| 1     | [Security patches](./phase-1-security-patches.md)                                  | Known direct-dependency vulnerabilities are patched            |
| 2     | [TypeScript 6](./phase-2-typescript-6.md)                                          | The project uses the latest supported TypeScript toolchain     |
| 3     | [Dependency batches](./phase-3-dependency-batches.md)                              | Same-major dependencies are upgraded in compatible groups      |
| 4     | [Major upgrades](./phase-4-major-upgrades.md)                                      | Riskier major upgrades are handled one at a time               |
| 5A    | [Whiteboard contracts and adapter](./phase-5a-whiteboard-contracts-and-adapter.md) | Product code receives an engine-independent editor API         |
| 5B    | [Document format and legacy import](./phase-5b-whiteboard-document-and-import.md)  | Owned documents coexist safely with legacy scenes              |
| 5C    | [Owned UI shell](./phase-5c-whiteboard-ui-shell.md)                                | Drawstuff controls the editor UI through the engine contract   |
| 5D    | [Canvas foundation](./phase-5d-whiteboard-canvas-foundation.md)                    | The owned renderer supports viewport and selection             |
| 5E    | [Drawing tools](./phase-5e-whiteboard-drawing-tools.md)                            | The owned engine creates shapes, lines, free draw, and text    |
| 5F    | [Editing and history](./phase-5f-whiteboard-editing-and-history.md)                | Elements can be transformed, grouped in selections, and undone |
| 5G    | [Assets, export, and viewer](./phase-5g-whiteboard-assets-export-viewer.md)        | Images, portable exports, and public read-only viewing work    |
| 5H    | [Migration rollout](./phase-5h-whiteboard-migration-rollout.md)                    | The owned engine is introduced behind a measured rollback path |
| 5I    | [Excalidraw removal](./phase-5i-excalidraw-removal.md)                             | The legacy runtime and dependency are removed safely           |
| 5J    | [Canonical V2 and owned-only writes](./phase-5j-canonical-whiteboard-v2.md)        | Existing owned work converges on one final persistence design  |
| 5K    | [Data convergence and cutover](./phase-5k-whiteboard-data-convergence.md)          | Every persisted document is converted and verified             |
| 5L    | [Irreversible legacy purge](./phase-5l-whiteboard-legacy-purge.md)                 | All legacy, migration, compatibility, and rollout code is gone |

## Existing-phase policy

Phases 5A through 5I remain the implementation history and are not reopened by
the zero-legacy extension. In particular, Phase 5J builds on the completed
contracts, document work, UI, canvas, tools, editing, assets, rollout, and
runtime removal rather than reimplementing them.

Phases 5J through 5L provide the additional final-state guarantee:

- Production reads and writes one canonical owned document version.
- Canonical documents never embed original legacy payloads or rollback copies.
- One-time conversion code is deleted after every persisted document converges.
- Database backups remain operational artifacts outside product documents.
- No application-level rollback, legacy file import/export, stale-client
  fallback, or migration branch remains after Phase 5L.

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
