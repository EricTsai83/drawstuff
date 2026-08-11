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

```text
src/
  app/                 # App Router pages, API routes, published pages
  components/          # UI, dashboard, auth, and Excalidraw integrations
  hooks/               # Client-side hooks for editor and app behavior
  lib/                 # Shared utilities, encryption, export/import helpers
  server/
    api/               # tRPC routers and server context
    db/                # Drizzle schema and database access
```

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
NEXT_PUBLIC_COLLAB_RELAY_URL=ws://localhost:3105

# Maintenance
CRON_SECRET=strong-random-string
CLEANUP_OWNER_EMAIL=your.email@example.com
```

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

```bash
pnpm dev
pnpm build
pnpm preview
pnpm start
pnpm lint
pnpm lint:fix
pnpm typecheck
pnpm format:check
pnpm format:write
pnpm db:push
pnpm db:studio
pnpm admin:bootstrap --email operator@example.com
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
