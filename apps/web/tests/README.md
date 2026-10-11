# Web tests

Unit and component tests are grouped by product domain, so one area can be run
on its own (`pnpm exec vitest run tests/collab`) and a new test has an obvious
home.

| Folder      | Covers                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| `admin/`    | Operator console, retirement, maintenance jobs, quotas, data release      |
| `auth/`     | Sign-in, sign-out privacy, signed-out drafts                              |
| `collab/`   | Collaboration rooms, sessions, authority adapters, rate limits, snapshots |
| `editor/`   | Excalidraw canvas integration, local persistence, menus, follow mode      |
| `platform/` | Security headers, i18n, theme bootstrap, shared helpers                   |
| `publish/`  | Published-scene artifacts, SVG rendering, the public viewer               |
| `scene/`    | Owned scenes, workspaces, categories, uploads, share links, dashboard     |

Shared fixtures and harnesses live in `support/`; `e2e/` holds the Playwright
suites and `postgres/` the real-database adapter integration test.

To run only what a change affects, use `pnpm test:changed` (tests whose imports
reach files changed versus `main`) or `pnpm check:affected` from the repository
root.
