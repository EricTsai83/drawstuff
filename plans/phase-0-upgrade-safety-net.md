# Phase 0: Upgrade Safety Net

## Goal

Create a reliable baseline so dependency upgrades and the whiteboard rewrite
can be validated and rolled back independently.

## Scope

- CI quality gates
- Runtime and package-manager version pinning
- Existing lint warnings
- Next.js type-check enforcement
- Critical workflow test fixtures

## Tasks

### 1. Pin the runtime

- Add a Node version file for Node 24.
- Add a compatible `engines.node` entry to `package.json`.
- Keep pnpm on `10.15.1` during Phases 0–3.
- Ensure local development, CI, and Vercel use the same Node major.

### 2. Enforce TypeScript during builds

- Remove `typescript.ignoreBuildErrors` from `next.config.js`.
- Confirm `pnpm typecheck` passes before and after removal.
- Make typecheck an explicit CI step; do not depend only on `next build`.

### 3. Clean the lint baseline

Resolve the two existing warnings:

- Unnecessary hook dependencies in
  `src/hooks/excalidraw/use-scene-remote-revision-check.ts`.
- Unused `clearCurrentSceneWorkspaceIdFromStorage` in
  `src/hooks/scene-session-context.tsx`.

CI should fail on new ESLint errors. Warnings can be tightened after the
existing baseline is clean.

### 4. Add upgrade test coverage

Create stable fixtures and tests for:

- Google sign-in and sign-out.
- Scene create, rename, save, reload, move, publish, and delete.
- Local scene recovery.
- Loading an existing compressed Excalidraw scene.
- Image upload and restored binary files.
- PNG/SVG export.
- Published read-only scene rendering.
- Theme and language switching.

Keep at least three legacy scene fixtures:

- Shapes and text.
- Images and binary files.
- A larger scene containing arrows, groups, and viewport state.

### 5. Establish dependency checks

- Run a dependency security audit in CI.
- Document accepted transitive findings with their parent package.
- Do not add broad `pnpm.overrides` without a compatibility test.
- Add an unused-dependency check or schedule a periodic Knip audit.

## Verification

```bash
pnpm typecheck
pnpm lint
SKIP_ENV_VALIDATION=1 pnpm build
```

Manually exercise authentication, database access, UploadThing, the editor,
scene export, and the public viewer.

## Rollback

Changes in this phase are configuration and test changes. Revert the individual
commit that introduced a failing gate; do not disable all quality gates to
unblock an unrelated upgrade.

## Exit criteria

- Type errors can no longer be ignored by production builds.
- Typecheck, lint, and build pass in CI.
- Node and pnpm versions are reproducible.
- Legacy scene fixtures exist.
- Critical workflows have a written or automated verification path.

