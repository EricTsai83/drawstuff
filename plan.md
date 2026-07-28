# Drawstuff restoration and Turborepo migration plan

## Objective

Starting point:

- source and product layout: commit
  `9d78bbab885cfff1a9261a99540fcd9a03335673`
- recovery branch for the pre-rollback codebase:
  `backup/pre-rollback-dbe0ee8`
- implementation branch: `restore/9d78bba`

Target:

- retain the page structure, control placement, information hierarchy, and
  workflows from `9d78bba`
- move the single Next.js app into the current Turborepo layout
- use the current package and toolchain versions from `dbe0ee8`
- use the current shadcn Base Nova component style without adopting the
  redesigned page layouts from `dbe0ee8`
- use the official `@excalidraw/excalidraw` package as the only whiteboard
  runtime
- preserve native Excalidraw element data so realtime collaboration remains
  possible later

This plan does not reintroduce the owned whiteboard renderer or the V3-owned
canvas UI.

## Non-negotiable constraints

1. `9d78bba` is the product-layout reference.
   - Keep the same page composition and component placement.
   - Keep the same desktop and mobile information hierarchy.
   - Keep the Excalidraw main menu, top-right controls, scene-name trigger,
     footer, dialogs, dashboard, login, and published-scene flows in their
     original locations.
2. `dbe0ee8` is the infrastructure and dependency reference.
   - Reuse its Turborepo, pnpm, Node, TypeScript, Next.js, lint, formatting,
     test, and CI configuration where compatible.
   - Do not copy its owned whiteboard runtime, whiteboard shell, or redesigned
     page composition.
3. Base Nova is a primitive/style migration only.
   - `components/ui/*`, component APIs, tokens, and visual treatment may
     change.
   - Product component order, layout regions, and trigger placement must not
     change.
4. Official Excalidraw remains the runtime source of truth.
   - Pin the package version during restoration.
   - Do not reduce Excalidraw elements to an engine-neutral field subset.
   - Do not remove unknown native element properties during serialization.
5. Every phase must be independently shippable and reversible.
   - No phase may combine a repository move, dependency upgrade, component
     primitive migration, and data migration in one change.

## Target repository structure

```text
drawstuff/
├── apps/
│   └── web/
│       ├── public/
│       ├── src/
│       ├── components.json
│       ├── drizzle.config.ts
│       ├── next.config.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── vercel.json
├── packages/
│   └── (reserved for later extraction; initially empty)
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── turbo.json
├── eslint.config.ts
├── prettier.config.ts
└── tsconfig.json
```

The first Turborepo milestone keeps Excalidraw directly in
`apps/web/package.json`. Extracting an internal package is a later, separate
milestone after the official runtime is stable.

## Target version baseline

Use the versions from `backup/pre-rollback-dbe0ee8` as the upgrade target:

### Root toolchain

- Node `24.18.0`
- pnpm `11.17.0`
- Turbo `2.10.7`
- TypeScript `6.0.3`
- ESLint `9.39.5`
- Prettier `3.9.6`

### Web application

- Next.js `16.2.12`
- React and React DOM `19.2.8`
- Tailwind CSS `4.3.3`
- Base UI `1.6.0`
- shadcn CLI `4.15.0`
- Vitest `4.1.10`
- Playwright `1.62.0`
- Better Auth `1.6.25`
- tRPC `11.18.0`
- Zod `4.4.3`

### Whiteboard runtime

- add `@excalidraw/excalidraw` as an exact direct dependency
- start with `0.18.1`, the last official package version used by this
  repository before the owned-engine cutover
- do not use a caret range until restoration and collaboration fixtures pass

Compatibility-only packages that are used by `9d78bba` but absent from
`dbe0ee8` must be handled explicitly:

- replace direct Radix packages with Base Nova components
- replace `use-debounce` usage with the local hook
- review `idb-keyval`; retain it only if the restored local-storage behavior
  still requires it

## Phase 0 — Freeze the restored product baseline

### Work

- Install the `9d78bba` lockfile without upgrading dependencies.
- Run the restored application against non-production data.
- Capture reference screenshots for:
  - empty editor
  - editor with a named scene
  - editor menus, export dialog, workspace dialog, and conflict dialogs
  - dashboard grid and scene actions
  - login page and intercepted login modal
  - published scene page
  - desktop and mobile
  - light and dark themes
- Create representative native Excalidraw fixtures:
  - rectangle, ellipse, diamond
  - text and bound text
  - line and arrow bindings
  - groups and frames
  - freedraw
  - images
  - deleted elements
  - links and `customData`
- Record current route behavior and user workflows.

### Exit criteria

- The baseline builds and typechecks with its original dependency graph.
- Reference screenshots and fixtures are committed.
- No production database is accessed by the restored application.

## Phase 1 — Move the unchanged app into Turborepo

This phase changes paths and orchestration only. It must not upgrade
dependencies or alter UI components.

### Work

1. Create the root workspace files based on `dbe0ee8`:
   - `pnpm-workspace.yaml`
   - `turbo.json`
   - root `package.json`
   - root `tsconfig.json`
   - root ESLint and Prettier configuration
2. Move the existing application:
   - `src/` → `apps/web/src/`
   - `public/` → `apps/web/public/`
   - `.env.example` → `apps/web/.env.example`
   - `components.json` → `apps/web/components.json`
   - Next, PostCSS, Drizzle, TypeScript, and Vercel configuration into
     `apps/web/`
3. Create `apps/web/package.json` from the restored single-app manifest.
4. Change the package name to `@drawstuff/web`.
5. Preserve the `@/*` alias as `apps/web/src/*`.
6. Update scripts and CI paths without changing application behavior.
7. Keep `packages/*` in the workspace configuration but do not create an
   internal whiteboard package yet.

### Exit criteria

- Screenshots match Phase 0.
- All routes and dialogs remain in the same locations.
- `pnpm --filter @drawstuff/web build` succeeds.
- Root Turbo commands call the web package successfully.
- There are no application imports from the repository root.

## Phase 2 — Upgrade infrastructure and dependencies

Upgrade in small groups and keep a green commit after every group.

### Group A: package manager and toolchain

- Node and pnpm
- Turbo
- TypeScript
- ESLint and TypeScript ESLint
- Prettier

### Group B: framework

- React and React DOM
- Next.js
- `@types/node`, `@types/react`, and `@types/react-dom`
- convert `next.config.js` to `next.config.ts`
- convert `src/env.js` to `src/env.ts`

### Group C: data and application libraries

- Better Auth
- tRPC and TanStack Query
- Drizzle
- Zod
- UploadThing
- remaining runtime utilities

### Group D: official Excalidraw

- pin `@excalidraw/excalidraw` to `0.18.1`
- keep the original `<Excalidraw>` composition from `9d78bba`
- keep the official Excalidraw CSS import
- resolve API/type changes without replacing the runtime
- verify `initialData`, `onChange`, `updateScene`, files, export, and published
  viewer behavior

### Rules

- Do not perform layout cleanup while resolving dependency changes.
- Do not copy the `OwnedWhiteboardCanvas` or `WhiteboardShell` from
  `dbe0ee8`.
- Do not add `@drawstuff/whiteboard` during this phase.
- Keep each upgrade group independently revertible.

### Exit criteria

- Typecheck, lint, test, and build pass on the current version baseline.
- Official Excalidraw handles editing and rendering.
- Phase 0 layout screenshots still match apart from expected font rendering
  differences.

## Phase 3 — Migrate UI primitives to Base Nova

The shadcn migration must use merge semantics. Do not overwrite the product
components or apply a preset destructively.

### Work

1. Change `apps/web/components.json` to the current Base Nova configuration:
   - style `base-nova`
   - Base UI primitives
   - Lucide icons
   - Tailwind v4 CSS file at `src/styles/globals.css`
2. Inventory the UI primitives used by the restored app.
3. For every installed component:
   - inspect the current local implementation
   - preview the Base Nova version with shadcn `--dry-run` and `--diff`
   - migrate the primitive implementation
   - adapt Radix `asChild` call sites to Base UI `render`
   - retain accessibility titles, descriptions, focus handling, and controlled
     open state
4. Migrate global semantic tokens and component styles.
5. Keep product layout classes on product components rather than embedding
   product placement into `components/ui/*`.
6. Compare every page against Phase 0 after each component family:
   - buttons and labels
   - inputs and forms
   - cards and badges
   - dialogs and alert dialogs
   - popovers and tooltips
   - dropdown menus and selects
   - command and multiple selector

### Layout invariants

- Do not move dashboard controls.
- Do not move workspace controls.
- Do not replace the original editor regions with the redesigned
  `WhiteboardShell`.
- Do not change modal routes or intercepted-route behavior.
- Do not change the position of Excalidraw children or custom render slots.
- Use Base Nova visual styles, but retain the original parent flex/grid
  structure and responsive breakpoints.

### Exit criteria

- `components.json` reports Base Nova.
- Direct Radix dependencies are removed.
- Product layout screenshot geometry remains aligned with Phase 0.
- Keyboard navigation, focus restoration, escape handling, and screen-reader
  titles pass.

## Phase 4 — Establish an Excalidraw-native persisted document

Do not deploy the restored raw schema directly against a database that has
already been finalized to Whiteboard V3.

### Target document

Create a versioned application envelope while preserving native Excalidraw
elements:

```ts
interface DrawstuffDocumentV4 {
  readonly version: 4;
  readonly engine: {
    readonly name: "excalidraw";
    readonly version: "0.18.1";
  };
  readonly scene: {
    readonly elements: readonly unknown[];
    readonly appState: Readonly<Record<string, unknown>>;
  };
  readonly assets: Readonly<Record<string, DrawstuffAssetMetadata>>;
  readonly metadata: {
    readonly name: string;
  };
}
```

The implementation should use official Excalidraw types at runtime, while the
persistence layer must preserve unknown JSON fields.

### Shared versus local state

Persist and synchronize:

- complete ordered Excalidraw elements
- recent deleted-element tombstones
- native element versions and fractional indices
- file IDs and asset metadata
- document-level theme, background, and grid settings

Keep per-user:

- scroll and zoom
- active tool
- selection
- open dialogs and menus
- last-used style

Keep realtime-only:

- pointer position
- username and presence
- idle status
- selected element IDs shown to collaborators
- visible scene bounds and follow state

### Compatibility

- raw legacy Excalidraw payload → V4 reader
- current Whiteboard V3 payload → V4 converter if production contains V3 rows
- V4 → native Excalidraw scene
- V4 serialization must preserve unknown element fields
- never rename native fields such as `updated`
- never drop `version`, `versionNonce`, `index`, `isDeleted`, bindings,
  `boundElements`, `link`, or `customData`

### Rollout

1. Inspect and count production `document_version` values using a read-only
   query.
2. Validate conversion against a database clone.
3. Save an immutable database snapshot.
4. Deploy a reader that supports the formats actually present.
5. Pause writes.
6. Migrate and semantically verify scenes, shared scenes, and asset references.
7. Deploy V4 writes.
8. Resume writes only after the application and constraints agree.

### Exit criteria

- Native fixtures survive load → save → load without field loss.
- Images and bindings remain valid.
- Current production scenes, if any, have an audited migration path.
- Realtime collaboration can later use official reconciliation fields.

## Phase 5 — Restore and extend verification

Port the useful infrastructure checks from `dbe0ee8`, excluding tests that
assert the owned engine or V3-only client bundle.

### Required commands

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm knip
pnpm build
pnpm audit:ci
pnpm --filter @drawstuff/web test:e2e
```

### Required browser coverage

- create and edit every supported element type
- text editing and IME input
- undo and redo
- clipboard copy and paste
- image upload and hydration
- local persistence
- cloud save and revision conflict
- scene switching and unsaved-change confirmation
- link sharing
- published read-only scene
- export to file, PNG, and share link
- desktop Chromium
- desktop WebKit
- mobile viewport
- keyboard accessibility and Axe

### Architecture guards

- fail if `OwnedWhiteboardCanvas` or the custom renderer is imported
- fail if app code deep-imports a future internal package
- fail if native Excalidraw element serialization drops collaboration fields
- fail if product components import Radix directly after Base Nova migration

## Phase 6 — Optional internal package extraction

This phase starts only after the direct official integration is stable in
production.

### Package boundary

Create `packages/whiteboard` as a wrapper around the official package, not as a
fork or copied renderer.

It may own:

- the Excalidraw React adapter
- native document serialization
- import and export helpers
- collaboration-facing contracts
- runtime-independent tests

It must not own:

- authentication
- tRPC
- database queries
- workspaces
- product dialogs
- Next.js routes
- UploadThing integration

`apps/web` continues to own the product composition and therefore retains the
layout restored from `9d78bba`.

### Exit criteria

- extraction produces no visual or behavioral change
- app code imports only the package root
- official Excalidraw remains the internal runtime
- the package can later host collaboration adapters without changing product
  pages

## Proposed pull request sequence

1. `restore: freeze 9d78bba product baseline`
2. `chore: move restored web app into Turborepo`
3. `chore: upgrade toolchain and framework`
4. `chore: upgrade application dependencies`
5. `refactor: pin and stabilize official Excalidraw`
6. `refactor: migrate UI primitives to Base Nova`
7. `feat: add Excalidraw-native V4 persistence`
8. `test: add browser, visual, and data round-trip gates`
9. `refactor: extract official whiteboard adapter` (optional)

## Completion definition

The migration is complete when:

- the repository uses the current Turborepo structure and toolchain
- the web app uses the current dependency baseline
- UI primitives use Base Nova
- page structure and control placement still match `9d78bba`
- the official Excalidraw package is the only canvas runtime
- saved documents retain complete native Excalidraw collaboration data
- production data has a verified migration or compatibility path
- all static, unit, build, browser, accessibility, and data round-trip gates
  pass
