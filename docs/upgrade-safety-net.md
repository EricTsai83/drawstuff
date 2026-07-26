# Upgrade safety net

## Reproducible toolchain

- Local development and CI read Node major `24` from `.node-version`.
- `package.json#engines.node` is `24.x`; Vercel uses this engine declaration
  for its build runtime.
- `packageManager` remains pinned to pnpm `10.15.1` through Phases 0–3.

## TypeScript 6 performance baseline

Measured on 2026-07-26 with Node `24.18.0` and pnpm `10.15.1`. Each cold run
started without `tsconfig.tsbuildinfo`; the incremental run immediately repeated
`pnpm typecheck` against the generated cache.

| Toolchain          |   Cold | Incremental |
| ------------------ | -----: | ----------: |
| TypeScript `5.9.3` | 5.88 s |      2.57 s |
| TypeScript `6.0.3` | 5.55 s |      2.38 s |

The TypeScript 6 run was 0.33 s faster cold and 0.19 s faster incrementally on
this machine. Editor diagnostics startup was not recorded because there is no
reproducible editor-performance harness in the repository.

The production `skipLibCheck: true` setting remains in place. An investigative
run with `skipLibCheck: false` reaches application sources but reports declaration
errors in dependencies and duplicated Next.js generated global types; these
upstream declaration failures are not suppressed with a TypeScript deprecation
override.

## Production dependency audit baseline

`pnpm audit:ci` runs a live production audit and compares every
`GHSA:package` key with `security/audit-baseline.json`. A newly reported key
fails CI. A finding disappearing from the registry is allowed and should be
removed from the baseline during the next dependency phase.

The baseline was reviewed after the Phase 1 security patches on 2026-07-26
and contains 26 unique `GHSA:package` advisory keys. pnpm reports 29
vulnerability instances: 1 critical, 14 high, 12 moderate, and 2 low. It is
an inventory, not a claim that the findings are safe. Findings against the
Phase 1 direct dependencies are cleared; the remaining findings are pinned
transitive packages and are tracked through their direct parent instead of
being forced with broad `pnpm.overrides`.

| Parent package           | Remaining transitive relationship                                          | Baseline summary                     | Follow-up                                                        |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `better-auth`            | `defu` and the `drizzle-kit > esbuild` tree                                | 3 advisory keys; includes 1 high     | Track Better Auth and Drizzle Kit releases; do not force esbuild |
| `next`                   | `postcss`, `sharp`, and `styled-jsx > @babel/core`                         | 5 advisory keys; includes 3 high     | Track the Next.js-pinned build and image-processing packages     |
| `drizzle-orm`            | Optional `gel > shell-quote` connector tree                                | 2 advisory keys; includes 1 critical | Track Drizzle/Gel; the application uses the PostgreSQL connector |
| `@excalidraw/excalidraw` | `nanoid`, Sass (`immutable`, `picomatch`), and Mermaid (`lodash-es`) trees | 8 advisory keys; includes 4 high     | Track upstream until the Phase 5 whiteboard replacement          |
| `@uploadthing/react`     | `@uploadthing/shared > effect`                                             | 1 high advisory key                  | Refresh UploadThing with upload/restore smoke tests              |
| `shadcn`                 | CLI-only tree (`brace-expansion`, `js-yaml`, Hono)                         | 7 advisory keys; includes 3 high     | Refresh the CLI dependency without runtime overrides             |

## Automated workflow coverage

`pnpm test` covers the stable boundaries that do not require live credentials:

- Google sign-in parameters and sign-out success callback.
- Scene create, save, reload, rename, move, publish, delete, ownership
  rejection, and deferred UploadThing cleanup through the tRPC caller.
- Local scene recovery, including deleted-element filtering and viewport data.
- Existing compressed scene decoding.
- Image extraction, upload compression, binary metadata restoration, and
  completeness checks.
- PNG export policy and native Excalidraw SVG rendering.
- Mermaid-to-Excalidraw flowchart conversion and the patched sequence-label
  XSS payload, including an assertion that the converter's temporary DOM
  insertions never contain executable event handlers.
- Published scene decoding with `viewModeEnabled`, cleared private viewport,
  and restored files.
- Theme mapping plus language persistence and browser notification.

`pnpm knip` checks production dependencies on every push and pull request as
part of `.github/workflows/ci.yaml`; the two already-known unused packages,
`idb-keyval` and `use-debounce`, remain explicitly listed in `knip.json` for
the planned Phase 3 removal, so any new unused production dependency fails.

The fixtures under `tests/fixtures/legacy-scenes` are compatibility inputs and
must not be regenerated as part of a dependency upgrade:

- `shapes-and-text.excalidraw`
- `images-and-binary-files.excalidraw`
- `large-groups-and-viewport.excalidraw`
- `pre-migration-bindings.excalidraw` (pre-index fields and legacy bindings)
- `shapes-and-text.compressed.base64` (stable compressed representation)

## Manual smoke checklist

Use a disposable account, workspace, and scene. Record the deployment URL,
browser, commit, and result for each item.

- [ ] Sign in with Google, return to `/`, then sign out and confirm protected
      dashboard data is no longer visible.
- [ ] Open the editor and confirm authenticated database-backed workspaces and
      scenes load.
- [ ] Create a scene, rename it, save edits, reload the page, and confirm the
      name, elements, viewport, and revision survive.
- [ ] Move the scene to another owned workspace and confirm both the dashboard
      card and editor session reflect the destination.
- [ ] Upload an image through UploadThing, save, reload, and confirm the binary
      renders; inspect the browser console for failed asset fetches.
- [ ] Export the scene as `.excalidraw`, PNG, and SVG and open each artifact.
- [ ] Open Text to diagram, insert both a flowchart and a sequence diagram,
      confirm the generated shapes land on the canvas, and check the browser
      console for conversion or dynamic-import errors.
- [ ] Publish the scene, open `/p/[slug]` in a signed-out window, confirm it is
      read-only, then unpublish and confirm the URL no longer resolves.
- [ ] Delete the scene and confirm its dashboard card and uploaded assets are
      removed (or queued for deferred cleanup).
- [ ] Leave unsaved local content, reload, and confirm local recovery.
- [ ] Switch light/dark/system theme and English/Traditional Chinese, then
      reload and confirm both preferences remain.
