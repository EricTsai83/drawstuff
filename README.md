# drawstuff

- A modern Excalidraw-powered drawing app built with Next.js 15, React 19, tRPC v11, Drizzle ORM, Tailwind CSS v4, and UploadThing. Heavily inspired by the original Excalidraw repository, this project re-architects the experience on Next.js and completes a full cloud-sync workflow. It re-implements end-to-end encrypted sharing links, adds a dedicated import-scenes page, and introduces workspace segmentation to help users better organize their saved scenes.

- **Framework**: Next.js App Router, React Server Components, Turbopack (dev)
- **API**: tRPC v11 on the server; client uses React Query
- **DB**: PostgreSQL + Drizzle ORM (table prefix: `excalidraw-ericts_`)
- **Auth**: better-auth (Google OAuth)
- **Uploads**: UploadThing (files and thumbnails)
- **Styling**: Tailwind CSS v4
- **i18n**: lightweight hooks for app/editor language
- **Deployment**: Vercel (includes weekly Cron job for cleanup)


## Features

- **Google Sign-In** using better-auth
- **Workspaces** per user with segmentation, plus last-active and default workspace tracking for better organization
- **Cloud sync**: persist scenes, file attachments, and thumbnails via Postgres/UploadThing
- **Scenes**: create, save, rename, delete, archive, list, and query
- **Categories**: auto-create and sync scene categories; automatic orphan cleanup
- **Sharing (E2E)**: end-to-end encrypted sharing links (client-side), with compressed payloads and short IDs
- **Import scenes page**: bring external or shared scenes into your workspace in one step
- **Thumbnails**: optional scene thumbnails stored via UploadThing
- **Dashboard**: search/list scenes with pagination (infinite and regular)
- **Editor**: Excalidraw integration with custom toolbar and export/upload flows
- **Maintenance**: weekly cleanup endpoint for pruning demo data and old shares


## Tech Stack

- Next.js 15, React 19
- tRPC v11, @tanstack/react-query v5, superjson
- Drizzle ORM + PostgreSQL
- better-auth (Google OAuth)
- UploadThing (@uploadthing/react, server SDK)
- Tailwind CSS v4
- TypeScript, ESLint, Prettier


## Requirements

- Node.js 20+ (recommend LTS)
- pnpm 10+
- A PostgreSQL database (local or hosted)
- UploadThing account/token for file storage
- Google OAuth credentials (Client ID/Secret)


## Getting Started

1) Clone and install

```bash
pnpm install
```

2) Configure environment variables by creating `.env.local` in the project root:

```bash
# Required (server)
UPLOADTHING_TOKEN=your-uploadthing-token
POSTGRES_URL=postgresql://user:pass@host:port/db
POSTGRES_URL_NON_POOLING=postgresql://user:pass@host:port/db
POSTGRES_USER=user
POSTGRES_HOST=host
POSTGRES_PASSWORD=pass
POSTGRES_DATABASE=db
POSTGRES_URL_NO_SSL=postgresql://user:pass@host:port/db
POSTGRES_PRISMA_URL=postgresql://user:pass@host:port/db
BETTER_AUTH_SECRET=generate-a-strong-random-string
BETTER_AUTH_URL=https://your-domain.example
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
CRON_SECRET=strong-random-string-16+
CLEANUP_OWNER_EMAIL=your.email@example.com

# Required (client)
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

3) Database setup (Drizzle)

- Drizzle is configured in `drizzle.config.ts` and uses tables prefixed with `excalidraw-ericts_`.
- Run migrations/generate/studio with:

```bash
pnpm db:generate   # generate SQL from current schema
pnpm db:migrate    # run SQL migrations
# or
pnpm db:push       # push current schema directly (no migration files)
pnpm db:studio     # open Drizzle Studio UI
```

4) Start development server

```bash
pnpm dev
```

Then open `http://localhost:3000`.


## Scripts

From `package.json`:

- `dev`: start Next.js dev server (Turbopack)
- `build`: production build
- `start`: start production server
- `preview`: build then start
- `lint` / `lint:fix`: run ESLint
- `typecheck`: TypeScript check
- `format:check` / `format:write`: Prettier check/write
- `db:generate` / `db:migrate` / `db:push` / `db:studio`: Drizzle workflows


## Environment Variables

Validated via `@t3-oss/env-nextjs` in `src/env.js`.

Server-side:
- `NODE_ENV` (development | test | production)
- `UPLOADTHING_TOKEN`
- `POSTGRES_URL`
- `POSTGRES_URL_NON_POOLING`
- `POSTGRES_USER`
- `POSTGRES_HOST`
- `POSTGRES_PASSWORD`
- `POSTGRES_DATABASE`
- `POSTGRES_URL_NO_SSL`
- `POSTGRES_PRISMA_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CRON_SECRET` (used by cleanup endpoint auth)
- `CLEANUP_OWNER_EMAIL` (data owner to keep when cleaning up)

Client-side:
- `NEXT_PUBLIC_BASE_URL`

Tip: set `SKIP_ENV_VALIDATION=1` for containers if you must bypass env validation (not recommended).


## API Overview

The app uses tRPC v11 for server APIs (see `src/server/api`). Main routers:

- `sceneRouter` (`src/server/api/routers/scene.ts`)
  - `saveScene` (create/update + category sync)
  - `getScene`, `getUserScenes`, `getUserScenesList`, `getUserScenesInfinite`
  - `renameScene`, `deleteScene`
- `sharedSceneRouter` (`src/server/api/routers/shared-scene.ts`)
  - `getCompressedBySharedSceneId` (public)
  - `getFileRecordsBySharedSceneId` (public)
- `workspaceRouter` (in `src/server/api/routers/workspace.ts`)

The root router is in `src/server/api/root.ts`.


## Maintenance / Weekly Cleanup (Vercel Cron)

To keep demo data and storage usage under control, this project exposes `POST /api/maintenance/cleanup` (also supports `GET` for convenience). Authorization uses a static bearer token:

- Header: `Authorization: Bearer <CRON_SECRET>`

Vercel schedule is configured in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/maintenance/cleanup", "schedule": "30 3 * * 1" }
  ]
}
```

- The cron uses UTC time. Adjust as needed.
- You can also trigger it manually using query `?cron_secret=<CRON_SECRET>` or the `Authorization` header.

Local test example:

```bash
curl -X POST \
  "http://localhost:3000/api/maintenance/cleanup" \
  -H "Authorization: Bearer $CRON_SECRET"
```

What the cleanup does:
- Deletes all users except the one whose email equals `CLEANUP_OWNER_EMAIL` (cascades related data)
- Collects and deletes UploadThing files for removed users and expired shares; failed deletions are enqueued for deferred cleanup
- Deletes `shared_scene` entries older than 30 days
- Deletes orphan categories not used by any scene
- Deletes expired sessions and verifications
- Purges deferred cleanup tasks that are done/failed and older than 30 days

Deferred cleanup tasks are stored in `excalidraw-ericts_deferred_file_cleanup` and retried with backoff up to a limit.


## Database

Tables are defined in `src/server/db/schema.ts` using Drizzle ORM and are all prefixed with `excalidraw-ericts_`. Key tables include:

- `user`, `session`, `account`, `verification`
- `workspace`, `user_default_workspace`, `user_last_active_workspace`
- `scene`, `category`, `scene_category`
- `shared_scene` (compressed scene data)
- `file_record` (UploadThing file metadata; XOR constraint on `scene_id`/`shared_scene_id`)
- `deferred_file_cleanup` (retry queue for file deletions)

If you change the schema:

```bash
pnpm db:generate
pnpm db:migrate
# or
pnpm db:push
```

`drizzle.config.ts` reads `POSTGRES_URL` from env.


## File Uploads & Thumbnails

- Uploads use UploadThing. Ensure `UPLOADTHING_TOKEN` is configured.
- File metadata is stored in `file_record`. For deletions, the system attempts to remove remote files and falls back to deferred cleanup when necessary.
- Scenes may include an optional `thumbnail_url` and `thumbnail_file_key` for previews.


## Project Structure (Selected)

```
src/
  app/                    # Next.js App Router routes
    api/                  # Route handlers (REST-style), e.g., maintenance/cleanup
  components/             # UI components, Excalidraw integrations, dialogs
  hooks/                  # React hooks (i18n, editor, dashboard, etc.)
  lib/                    # Utilities (encryption, export/import, schemas)
  server/
    api/                  # tRPC routers and context
    db/                   # Drizzle schema and queries
  styles/                 # Tailwind CSS globals
  trpc/                   # Client bindings, React Query setup
```


## Development Tips

- Prefer running `pnpm check` before commits (`next lint` + `tsc --noEmit`).
- For local DB: ensure your Postgres connection string matches SSL settings (`POSTGRES_URL_NO_SSL` is available if needed).
- The app expects `NEXT_PUBLIC_BASE_URL` to reflect the current origin.


## Troubleshooting

- Auth callback URL mismatch: ensure `BETTER_AUTH_URL` and your OAuth client settings match the deployment URL.
- UploadThing failures: verify `UPLOADTHING_TOKEN`; check CORS/origin configuration in your UploadThing dashboard.
- Drizzle connection issues: double-check `POSTGRES_URL` and SSL options; try `POSTGRES_URL_NO_SSL` locally.
- 401 on cleanup endpoint: confirm `CRON_SECRET` and that you are passing `Authorization: Bearer <CRON_SECRET>`.


## License

MIT License. See the LICENSE file for details.