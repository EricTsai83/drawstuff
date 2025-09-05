# drawstuff
 ![drawstuff](/assets/drawstuff.png)

- A Next.js–based, cloud‑synced whiteboard powered by [Excalidraw]((https://github.com/excalidraw/excalidraw)). Drawstuff introduces a new design for end-to-end encrypted share links, a dedicated scene import flow, and workspace segmentation for more organized storage.

## Features

- **Google Sign-In** via Better Auth
- **Workspaces** per user with segmentation; tracks last-active and default workspace
- **Cloud sync**: persist scenes, attachments, and thumbnails via Neon Postgres + UploadThing
- **Scenes**: create, save, rename, delete, archive, list, and query
- **Categories**: auto-create and sync scene categories; automatic orphan cleanup
- **Sharing (E2E)**: end-to-end encrypted share links (client-side), with compressed payloads and short IDs
- **Scene import**: bring external or shared scenes into your workspace in one step
- **Thumbnails**: optional scene thumbnails stored via UploadThing
- **Dashboard**: search/list scenes with pagination (infinite and regular)
- **Editor**: Excalidraw integration with custom main menu and export/upload flows
- **Maintenance**: weekly cleanup endpoint for pruning demo data and old shares


## Tech Stack

- [Next.js 15](https://github.com/vercel/next.js), [React 19](https://github.com/facebook/react)
- [Excalidraw](https://github.com/excalidraw/excalidraw)
- [tRPC v11](https://github.com/trpc/trpc)
- [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)
- [Neon](https://github.com/neondatabase/neon) (PostgreSQL)
- [Better Auth](https://github.com/better-auth/better-auth) (Google OAuth)
- [uploadThing](https://github.com/pingdotgg/uploadthing)
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) v4
- [Create T3 APP](https://github.com/t3-oss/create-t3-app)


## Requirements

- Node.js 20+ (recommend LTS)
- pnpm 10+
- A Neon PostgreSQL database (hosted)
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
CRON_SECRET=strong-random-string
CLEANUP_OWNER_EMAIL=your.email@example.com

# Required (client)
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

3) Database setup (Drizzle)

- Drizzle is configured in `drizzle.config.ts`; tables are prefixed with `excalidraw-ericts_` by default, and you can change the prefix to whatever you prefer.
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


## License

MIT License. See the LICENSE file for details.