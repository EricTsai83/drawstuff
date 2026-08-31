<p align="center">
  <img src="./assets/og-readme.png" width="600" alt="Logo for drawstuff">
</p>

<p align="center">
  A cloud-backed whiteboard built on top of Excalidraw.
</p>

## What is drawstuff?

drawstuff is an open-source whiteboard app built with [Excalidraw](https://github.com/excalidraw/excalidraw), [Next.js](https://github.com/vercel/next.js), and [tRPC](https://github.com/trpc/trpc). It combines a full-screen drawing experience with cloud persistence, workspace-based organization, encrypted sharing, and published public pages for read-only scene viewing.

## Key Features

- **Excalidraw-first editing** with import, export, autosave, and custom scene-management flows
- **Cloud-backed scenes** with thumbnails and attached binary assets
- **Workspace organization** with default and last-active workspace tracking
- **Search and filtering** by scene name, description, category, workspace, and publish state
- **Encrypted share links** using client-side compression and AES-GCM encryption
- **Real-time collaboration** with end-to-end encrypted rooms routed through a Cloudflare Durable Object gateway
- **Published public pages** at `/p/[slug]` for clean, read-only scene presentation
- **Bilingual UI** with English and Traditional Chinese support
- **Maintenance tooling** for scheduled cleanup and deferred file deletion retries

## Sharing Modes

### Private share links

Use the regular share flow when you want a private link.

- Scene payloads are compressed client-side before upload
- Shared links are encrypted in the browser with AES-GCM
- The decryption key stays in the URL hash
- Imported shared scenes can be brought back into a personal workspace

### Published public pages

Use publishing when you want a stable, read-only page that can be opened directly by URL.

- Publish and unpublish from the dashboard
- Each published scene gets a unique slug and public URL at `/p/[slug]`
- Public pages include Open Graph and Twitter metadata
- The viewer is read-only and includes theme, zoom, fit-to-screen, and reset controls

## Tech Stack

| Layer          | Technology                       |
| -------------- | -------------------------------- |
| Framework      | Next.js 16, React 19             |
| Drawing Engine | Excalidraw                       |
| API Layer      | tRPC v11                         |
| Database       | PostgreSQL, Drizzle ORM          |
| Auth           | Better Auth, Google OAuth        |
| File Storage   | UploadThing                      |
| UI             | Tailwind CSS v4, Base UI, Sonner |
| Utilities      | Zod, nuqs, date-fns              |

## Project Structure

This is a pnpm + Turborepo monorepo with two apps and two shared packages:

```text
apps/
  web/                          # The Next.js app (UI, tRPC API, persistence)
    src/
      app/                      # App Router pages, API routes, published pages
      components/               # UI, dashboard, auth, and Excalidraw integrations
      hooks/                    # Client-side hooks for editor and app behavior
      lib/                      # Shared utilities, encryption, export/import helpers
      server/
        api/                    # tRPC routers and server context
        db/                     # Drizzle schema and database access
  collaboration-do/             # Cloudflare Worker gateway + CollaborationRoom Durable Object
packages/
  excalidraw-adapter/           # The only boundary allowed to import @excalidraw/excalidraw
  collaboration/                # Transport-neutral collaboration protocol, crypto, recovery
```

Dependency direction is one-way: `apps/web` consumes both packages, the collaboration worker
consumes only the collaboration package's server-safe entries, and the two packages never import
each other. The full
ownership rules live in
[docs/architecture/architecture-contract.md](./docs/architecture/architecture-contract.md).

## Real-Time Collaboration

Collaboration rooms are end-to-end encrypted:

- The room key is generated in the browser and travels only in the URL fragment; it is never sent
  to the app backend, the realtime worker, or any log.
- Realtime frames, durable snapshots, binary assets, and the room key-check value are sealed under
  separate keys derived from the room key (HKDF), so leaking one never unlocks the others.
- The realtime worker (`apps/collaboration-do`) authenticates joins with short-lived signed
  tokens and routes opaque ciphertext by room and channel; it keeps no durable scene state.
- Rooms recover through snapshot exchange and reconciliation; membership and lifecycle changes are
  pushed to the worker through a signed server-to-server control endpoint.

Like every browser-delivered E2EE app, the encryption protects against passive infrastructure —
the relay, the database, object storage, and the network never hold a key. It cannot protect
against whoever controls the application code your browser runs; that trust boundary and its
mitigations are documented in the
[threat model](./docs/architecture/collaboration-threat-model.md).

The runtime contract lives in
[docs/architecture/collaboration-system-design.md](./docs/architecture/collaboration-system-design.md).

## Getting Started

### Prerequisites

- Node.js 24+
- pnpm 11+
- PostgreSQL database
- UploadThing token
- Google OAuth credentials

### Setup

```bash
# Clone the repository
git clone https://github.com/EricTsai83/drawstuff.git
cd drawstuff

# Install dependencies
pnpm install

# Copy environment variables
cp apps/web/.env.example apps/web/.env

# Push database schema
pnpm db:push

# Start development server
pnpm dev
```

Open `http://localhost:3000`.

## Environment Variables

The app validates its environment variables in `src/env.js`.

```bash
# Database
POSTGRES_URL=postgresql://user:pass@host:port/db
POSTGRES_URL_NON_POOLING=postgresql://user:pass@host:port/db
POSTGRES_USER=user
POSTGRES_HOST=host
POSTGRES_PASSWORD=pass
POSTGRES_DATABASE=db
POSTGRES_URL_NO_SSL=postgresql://user:pass@host:port/db
POSTGRES_PRISMA_URL=postgresql://user:pass@host:port/db

# Auth
BETTER_AUTH_SECRET=generate-a-strong-random-string
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Storage and app config
UPLOADTHING_TOKEN=your-uploadthing-token
NEXT_PUBLIC_BASE_URL=http://localhost:3000
# Durable Object gateway origins. The server composes generation-scoped
# socket/control paths; clients never receive provider state.
COLLAB_RELAY_URL=wss://drawstuff-collaboration-do.example.workers.dev
COLLAB_CONTROL_URL=https://drawstuff-collaboration-do.example.workers.dev
# Optional: authorizes /api/collaboration/control-outbox only (the Cloudflare
# Worker cron holds the same value as COLLAB_CRON_SECRET). Deliberately not
# CRON_SECRET; unset means the drain endpoint refuses everything.
COLLAB_OUTBOX_CRON_SECRET=another-strong-random-string

# Maintenance
CRON_SECRET=strong-random-string
CLEANUP_OWNER_EMAIL=your.email@example.com
```

`BETTER_AUTH_URL` and `NEXT_PUBLIC_BASE_URL` must contain the same public
origin, without a path, query, or fragment. Vercel production deployments
fail at build time unless that origin uses HTTPS and is not a loopback host.
Google's authorized redirect URI must be that origin followed by
`/api/auth/callback/google`.

## First Administrator Setup

Administrative access is stored in PostgreSQL under the immutable Better Auth user ID. Email is
used only once to locate an email-verified, Google-linked account during bootstrap; normal admin
authorization never compares email and does not use an `ADMIN_*` environment variable.

For the first deployment:

1. Configure the server environment and apply the schema:

   ```bash
   pnpm db:push
   ```

2. Deploy the application, then sign in to that deployment once with the Google account that will
   become the first operator. The login must happen in the target environment so Better Auth creates
   its `user` and Google `account` rows in the correct database.
3. From a trusted machine or protected one-off release job with the same target environment loaded,
   run:

   ```bash
   pnpm admin:bootstrap --email operator@example.com
   ```

4. Verify that the command reports `Granted operator access`. Re-running it for the same account is
   safe and reports that the operator is already active. Once any active operator exists, bootstrap
   refuses to grant a different account; later access changes must use the audited `/admin`
   management interface.
5. Sign in as that account and open `/admin`. The page performs a server-side grant check before it
   renders, and every query or mutation repeats the same database-backed authorization check. Use
   the interface to search accounts; selecting **Manage** opens the dedicated
   `/admin/users/[userId]` page for grants, room termination, and scene or account retirement.
   High-risk actions require typing the immutable target ID. Active operators also see an **Admin
   console** entry in the authenticated Canvas main menu.

Do not expose database credentials to the browser or implement bootstrap as a public endpoint. For
production schema checks, audit queries, retirement procedures, and recovery guidance, follow the
[administrative data retirement runbook](./docs/operations/admin-data-retirement.md).

## Useful Scripts

`package.json` is strict JSON and therefore cannot contain comments. This table
is the comment/reference for the root scripts instead.

| Script                                              | When to run it                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                          | During local development; starts the persistent workspace development tasks.                                              |
| `pnpm build`                                        | Before releasing, or when checking that production bundles compile.                                                       |
| `pnpm preview`                                      | To build and run the production-mode web app locally.                                                                     |
| `pnpm start`                                        | To run an already-built web app; it does not build first.                                                                 |
| `pnpm check`                                        | Before opening or merging a PR. Runs formatting checks, lint, typecheck, unit tests, and dead-code checks for the repo.   |
| `pnpm lint` / `pnpm lint:fix`                       | While coding; use `lint:fix` only when you want ESLint to modify files.                                                   |
| `pnpm typecheck`                                    | After TypeScript or dependency changes for a faster check than `pnpm check`.                                              |
| `pnpm test` / `pnpm test:coverage`                  | After behavior changes; use coverage when inspecting untested paths.                                                      |
| `pnpm test:e2e`                                     | After changing important browser flows. Requires Playwright's browser dependencies and the configured test environment.   |
| `pnpm format:check` / `pnpm format:write`           | Use `format:check` in verification and `format:write` when you want Prettier to modify files.                             |
| `pnpm knip`                                         | After deleting, moving, or exporting code to find unused files, exports, and dependencies.                                |
| `pnpm db:push`                                      | When the Drizzle schema changes and you deliberately want to update the configured database. This mutates database state. |
| `pnpm db:studio`                                    | When you need to inspect or edit the configured database interactively.                                                   |
| `pnpm admin:bootstrap --email operator@example.com` | Once, after the first production sign-in, to create the initial operator.                                                 |

Cloudflare collaboration Worker operations are deliberately separate from
`pnpm dev`:

| Script                                | When to run it                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm cf:typegen`                     | After changing `wrangler.jsonc` bindings or variables; commit the regenerated TypeScript declarations.                 |
| `pnpm cf:preflight`                   | Before a manual deploy to validate and bundle locally without changing Cloudflare.                                     |
| `pnpm cf:deploy`                      | For a deliberate manual Worker deploy. It runs package verification and preflight first, then changes the live Worker. |
| `pnpm cf:smoke <base-url>`            | Immediately after deployment to verify the live health and gateway contract.                                           |
| `pnpm cf:conformance <base-url>`      | Before cutover or after protocol/runtime changes to run the full remote compatibility suite.                           |
| `pnpm cf:loadtest <base-url> [flags]` | Only for targeted capacity or performance diagnosis; it intentionally creates remote load.                             |
| `pnpm cf:secrets`                     | During deployment setup or troubleshooting to list configured secret names (not values).                               |
| `pnpm cf:tail`                        | During live incident diagnosis; streams Worker logs until stopped.                                                     |

Secret values are intentionally set through the package-level interactive
commands so they are not exposed as shell arguments:

```bash
pnpm --filter @drawstuff/collaboration-do secret:put
pnpm --filter @drawstuff/collaboration-do secret:put:cron
pnpm --filter @drawstuff/collaboration-do secret:put:drain-url
```

## Maintenance Endpoint

This project includes a cleanup endpoint intended for demo or controlled deployments.

- Endpoint: `POST /api/maintenance/cleanup`
- Also accepts `GET` for convenience
- Auth: `Authorization: Bearer <CRON_SECRET>`
- Default Vercel schedule: `30 3 * * 1`

```bash
curl -X POST \
  "http://localhost:3000/api/maintenance/cleanup" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Review the cleanup behavior carefully before enabling it in production.

## License

MIT
