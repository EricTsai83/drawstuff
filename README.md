# drawstuff

Drawstuff is a full-screen whiteboard app built with [Excalidraw](https://github.com/excalidraw/excalidraw), [Next.js](https://github.com/vercel/next.js), and [tRPC](https://github.com/trpc/trpc). It combines a cloud-backed editor, workspace-based organization, encrypted share links, and published public pages for read-only scene viewing.

## What It Does

- Edit diagrams in a customized Excalidraw workspace
- Save scenes to the cloud with thumbnails and attached binary assets
- Organize work by workspace, category, search, and dashboard filters
- Share scenes through end-to-end encrypted links
- Publish scenes to public, read-only pages at `/p/[slug]`

## Highlights

- **Excalidraw editor** with custom export, upload, import, and scene-management flows
- **Google sign-in** through Better Auth
- **Workspace-aware storage** with default and last-active workspace tracking
- **Cloud persistence** for scene data, images, and thumbnails via Neon Postgres + UploadThing
- **Dashboard search** by name, description, category, workspace, and publish state
- **Categories** that are auto-created, synced, and cleaned up when orphaned
- **Scene lifecycle** support for create, rename, update, archive, delete, and import
- **Bilingual UI copy** for English and Traditional Chinese
- **Maintenance endpoint** for scheduled demo-data cleanup and deferred file deletion retries

## Two Sharing Modes

### 1. Encrypted share links

Use the regular share flow when you want a private link.

- Scene payloads are compressed client-side
- Shared links use client-side AES-GCM encryption
- The decryption key lives in the URL hash
- Imported shared scenes can be brought back into a personal workspace

### 2. Published public pages

Use the publish flow when you want a clean, read-only page that can be opened directly by URL.

- Publish and unpublish from the dashboard
- Each published scene gets a unique slug and a public URL at `/p/[slug]`
- The dashboard can filter scenes by `All`, `Published`, and `Unpublished`
- Public pages include metadata for Open Graph and Twitter cards
- The public viewer is read-only and includes theme toggle, zoom, fit-to-screen, and reset controls
- Public links can be copied or opened directly from the scene card menu

> Published public pages are not the same as encrypted share links. They are intended for presentation and read-only access, not end-to-end encrypted sharing.

## Core Routes

- `/` - the main editor workspace
- `/dashboard` - scene dashboard overlay
- `/login` - sign-in overlay
- `/p/[slug]` - public published-scene viewer
- `/api/maintenance/cleanup` - scheduled cleanup endpoint

## Tech Stack

- [Next.js 16](https://github.com/vercel/next.js)
- [React 19](https://github.com/facebook/react)
- [Excalidraw](https://github.com/excalidraw/excalidraw)
- [tRPC v11](https://github.com/trpc/trpc)
- [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)
- [Neon PostgreSQL](https://github.com/neondatabase/neon)
- [Better Auth](https://github.com/better-auth/better-auth)
- [UploadThing](https://github.com/pingdotgg/uploadthing)
- [Tailwind CSS v4](https://github.com/tailwindlabs/tailwindcss)
- [nuqs](https://github.com/47ng/nuqs), [Zod](https://github.com/colinhacks/zod), [Sonner](https://github.com/emilkowalski/sonner)

## Requirements

- Node.js 20+
- pnpm 10+
- A PostgreSQL database, typically Neon
- An UploadThing token for file storage
- Google OAuth credentials for Better Auth

## Local Development

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create `.env.local`

All of the variables below are validated by `src/env.js`.

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
CRON_SECRET=strong-random-string
CLEANUP_OWNER_EMAIL=your.email@example.com
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

### 3. Set up the database

`drizzle.config.ts` reads `POSTGRES_URL` and targets tables prefixed with `excalidraw-ericts_`.

```bash
pnpm db:generate
pnpm db:migrate
```

If you prefer pushing the schema directly during local development:

```bash
pnpm db:push
```

To inspect the database with Drizzle Studio:

```bash
pnpm db:studio
```

### 4. Start the app

```bash
pnpm dev
```

Open `http://localhost:3000`.

## Useful Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm typecheck
pnpm format:check
pnpm format:write
pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm db:studio
```

## Data Model Overview

The main tables live in `src/server/db/schema.ts`.

- `scene`: cloud-saved scenes, descriptions, thumbnails, workspace assignment, and publish state
- `shared_scene`: encrypted share-link payloads
- `file_record`: UploadThing metadata for assets tied to either a saved scene or a shared scene
- `workspace`, `user_default_workspace`, `user_last_active_workspace`: workspace management
- `category`, `scene_category`: scene categorization
- `deferred_file_cleanup`: retry queue for failed remote deletions

## Public Pages

The public-page feature is separate from the encrypted sharing flow.

- Publishing sets `isPublished`, stores a `publishedSlug`, and records `publishedAt`
- Public scene data is resolved server-side from the saved `scene` record
- Metadata is generated from the scene title, description, thumbnail, author name, and timestamps
- The public viewer loads the stored scene and related files into a stripped-down Excalidraw renderer
- Unpublishing removes the slug and makes the page unavailable

This makes public pages suitable for portfolio-style scene presentation while keeping the main editor workflow intact.

## Maintenance Cron

This project includes an opinionated cleanup endpoint intended for demo or controlled deployments.

- Endpoint: `POST /api/maintenance/cleanup`
- Also accepts `GET` for convenience
- Auth: `Authorization: Bearer <CRON_SECRET>`
- Default Vercel schedule: `30 3 * * 1` in `vercel.json`

Example:

```bash
curl -X POST \
  "http://localhost:3000/api/maintenance/cleanup" \
  -H "Authorization: Bearer $CRON_SECRET"
```

What it does:

- Deletes all users except the account whose email matches `CLEANUP_OWNER_EMAIL`
- Deletes expired `shared_scene` records older than 30 days
- Removes orphan categories
- Cleans expired sessions and verifications
- Deletes UploadThing files when possible and queues failed deletions for retry
- Purges old completed or failed deferred-cleanup tasks

Review this behavior carefully before enabling it in production.

## Notes

- `NEXT_PUBLIC_BASE_URL` must point to the deployed origin so copied public links and metadata resolve correctly
- `BETTER_AUTH_URL` should match your local or deployed app origin
- Scene data saved to the personal cloud library is compressed for storage; encrypted sharing is handled by the dedicated share-link flow

## License

MIT. See `LICENSE`.
