# Upgrade safety net

## Reproducible toolchain

- Local development and CI read Node major `24` from `.node-version`.
- `package.json#engines.node` is `24.x`; Vercel uses this engine declaration
  for its build runtime.
- `packageManager` remains pinned to pnpm `10.15.1` through Phases 0–3.

## Production dependency audit baseline

`pnpm audit:ci` runs a live production audit and compares every
`GHSA:package` key with `security/audit-baseline.json`. A newly reported key
fails CI. A finding disappearing from the registry is allowed and should be
removed from the baseline during the next dependency phase.

The baseline was reviewed on 2026-07-26 and contains 89 unique
`GHSA:package` advisory keys. pnpm reports 93 vulnerability instances:
2 critical, 38 high, 44 moderate, and 9 low. It is an inventory, not a claim
that the findings are safe. Direct findings are scheduled for Phase 1 rather
than hidden behind broad `pnpm.overrides`.

| Parent package           | Relationship                                                  | Baseline summary                      | Follow-up                                                    |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `better-auth`            | Direct plus its `kysely`, `defu`, `esbuild` tree              | 16 advisory keys; includes 1 critical | Upgrade and run Google OAuth tests in Phase 1                |
| `next`                   | Direct plus `postcss`, `sharp`, and `@babel/core`             | 28 advisory keys; includes 15 high    | Upgrade Next.js and verify build/server actions in Phase 1   |
| `drizzle-orm`            | Direct plus `gel > shell-quote`                               | 3 advisory keys; includes 1 critical  | Upgrade Drizzle with database compatibility tests in Phase 1 |
| `@excalidraw/excalidraw` | Direct plus Mermaid, DOMPurify, Sass, and utility packages    | 32 advisory keys; includes 4 high     | Covered by the legacy fixtures until the Phase 5 rewrite     |
| `@uploadthing/react`     | Transitive `@uploadthing/shared > effect`                     | 1 high advisory key                   | Upgrade UploadThing with upload/restore smoke tests          |
| `shadcn`                 | Transitive CLI-only tree (`brace-expansion`, `js-yaml`, Hono) | 9 advisory keys; includes 5 high      | Refresh the CLI dependency without runtime overrides         |

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
- [ ] Publish the scene, open `/p/[slug]` in a signed-out window, confirm it is
      read-only, then unpublish and confirm the URL no longer resolves.
- [ ] Delete the scene and confirm its dashboard card and uploaded assets are
      removed (or queued for deferred cleanup).
- [ ] Leave unsaved local content, reload, and confirm local recovery.
- [ ] Switch light/dark/system theme and English/Traditional Chinese, then
      reload and confirm both preferences remain.
