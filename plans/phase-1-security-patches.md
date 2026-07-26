# Phase 1: Security Patches

## Goal

Patch known vulnerabilities in direct production dependencies without mixing
in unrelated major upgrades.

## Target versions

| Package group | Current | Target |
| --- | --- | --- |
| `next` | `16.2.0` | `16.2.12` |
| `eslint-config-next` | `16.2.0` | `16.2.12` |
| `react` | `19.2.4` | `19.2.8` |
| `react-dom` | `19.2.4` | `19.2.8` |
| `@types/react` | `19.2.14` | `19.2.17` |
| `better-auth` | `1.5.5` | `1.6.25` |
| `drizzle-orm` | `0.45.1` | `0.45.2` |
| `@excalidraw/excalidraw` | `0.18.0` | `0.18.1` |
| `postcss` | `8.5.8` | `8.5.23` |

Keep `react` and `react-dom` on exactly matching versions.

## Delivery batches

### Batch A: Next.js and React

Upgrade together:

- `next`
- `eslint-config-next`
- `react`
- `react-dom`
- `@types/react`
- `@types/react-dom`, if a matching update is available

Verify:

- App Router navigation and intercepting routes.
- Server Actions.
- API routes.
- `next/image`.
- Authentication callbacks.
- UploadThing routes.
- Static and dynamic page rendering.

### Batch B: Authentication and database

Upgrade together:

- `better-auth`
- `drizzle-orm`

Review Better Auth release notes for schema or cookie changes before applying
database migrations. Do not generate or push schema changes until the diff is
reviewed.

Verify:

- Existing sessions.
- New Google OAuth sign-in.
- Sign-out and session invalidation.
- Drizzle queries and authorization checks.
- Scene and workspace CRUD.

### Batch C: Excalidraw security patch

Upgrade `@excalidraw/excalidraw` to `0.18.1`.

The expected functional change is the Mermaid XSS mitigation through
`@excalidraw/mermaid-to-excalidraw`.

Verify:

- Drawing and selection.
- Undo/redo.
- Scene restore.
- Images.
- Export.
- Mermaid/text-to-diagram entry points.
- Public viewer.

### Batch D: PostCSS

Upgrade direct PostCSS to `8.5.23`.

Re-run the security audit after regenerating the lockfile. Some build-time
transitive findings may remain because Next.js and other tools pin their own
PostCSS, Sass, glob, or Babel versions. Track those through the parent package
instead of forcing an override by default.

## Commands

Use pnpm and update only the intended batch. Example:

```bash
pnpm add next@16.2.12 react@19.2.8 react-dom@19.2.8
pnpm add -D eslint-config-next@16.2.12 @types/react@19.2.17
```

Run the full required checks after each batch.

## Rollback

- Each batch must be a separate commit or pull request.
- Revert the affected batch and its lockfile changes together.
- Database changes require a reviewed forward or reverse migration plan.

## Exit criteria

- All target direct dependencies are on the listed patched versions.
- Authentication, database, editor, upload, and viewer workflows pass.
- Remaining security findings are transitive, documented, and assigned to an
  upstream package or an explicit mitigation.

