<p align="center">
  <img src="./assets/og-readme.png" width="600" alt="drawstuff">
</p>

<p align="center">
  A cloud-backed whiteboard built on Excalidraw.
</p>

<p align="center">
  <a href="https://draw.ericts.com">Live app</a> ·
  <a href="./docs/README.md">Documentation</a>
</p>

## Overview

drawstuff is Excalidraw with an account: draw instantly without signing in, then keep your scenes
in the cloud, organize them, share them, and edit them together in real time.

### Features

- **Draw first, sign in later** – the editor works signed out; after signing in you can save the draft as a new scene
- **Cloud scenes** – autosave, thumbnails, images, import/export, and a personal library synced across devices
- **Organize** – workspaces, categories, search, filters, and archive
- **Share two ways** – end-to-end encrypted read-only links, or public pages at `/p/[slug]` with link previews
- **Real-time collaboration** – rooms with owner, invite list, and link access, like Google Docs
- **English and Traditional Chinese**, light and dark themes

> Only share links are end-to-end encrypted. Collaboration rooms are protected by sign-in and
> access rules; see the [threat model](./docs/architecture/collaboration-threat-model.md).

## Tech Stack

| Layer          | Technology                       |
| -------------- | -------------------------------- |
| Framework      | Next.js 16, React 19             |
| Drawing engine | Excalidraw                       |
| API            | tRPC v11                         |
| Database       | PostgreSQL, Drizzle ORM          |
| Authentication | Better Auth, Google OAuth        |
| Storage        | UploadThing                      |
| UI             | Tailwind CSS v4, Base UI, Sonner |
| Realtime       | Cloudflare Durable Objects       |

## Getting Started

### Prerequisites

- Node.js 24+
- pnpm 11+
- PostgreSQL
- UploadThing
- Google OAuth credentials
- Upstash Redis
- A deployed or locally running collaboration Worker

### Setup

```bash
git clone https://github.com/EricTsai83/drawstuff.git
cd drawstuff
pnpm install
cp apps/web/.env.example apps/web/.env
```

Fill in `apps/web/.env`, then initialize the database and start the web app:

```bash
pnpm db:push
pnpm dev
```

Open `http://localhost:3000`. The collaboration Worker runs separately from `pnpm dev`; see
[apps/collaboration-do/README.md](./apps/collaboration-do/README.md) for its configuration and
deployment workflow.

## Environment Variables

The complete template is [apps/web/.env.example](./apps/web/.env.example), and the validation schema
is [apps/web/src/env.ts](./apps/web/src/env.ts).

| Purpose        | Variables                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Database       | `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`                                                         |
| Authentication | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                |
| Storage        | `UPLOADTHING_TOKEN`                                                                                |
| Public origin  | `NEXT_PUBLIC_BASE_URL`                                                                             |
| Collaboration  | `COLLAB_IDENTITY_SECRET`, `COLLAB_AUTHORITY_SECRET`, `COLLAB_ADAPTER_SECRET`, `COLLAB_CONTROL_URL` |
| Rate limiting  | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                               |
| Maintenance    | `CRON_SECRET`, `CLEANUP_OWNER_EMAIL`                                                               |

The three collaboration secrets must each be at least 32 characters and match the Worker secrets of
the same name ([full list](./docs/operations/collaboration-do-deployment.md#2-secrets)).
`BETTER_AUTH_URL` and `NEXT_PUBLIC_BASE_URL` must be the same origin, and Google OAuth needs
`<origin>/api/auth/callback/google` as an authorized redirect URI.

## Architecture

```text
apps/
  web/                   # Next.js UI, tRPC API, and persistence
  collaboration-do/      # Cloudflare Worker and room/lifecycle Durable Objects
packages/
  excalidraw-adapter/    # The only package allowed to import Excalidraw
  collaboration/         # Transport-neutral protocol, authority contracts, codecs, and recovery
```

Dependencies flow one way: the web app consumes both shared packages, while the Worker consumes
only the server-safe collaboration entries. See the
[architecture contract](./docs/architecture/architecture-contract.md) for ownership rules.

## Useful Scripts

| Command                                         | Purpose                                                  |
| ----------------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                                      | Start the web development server                         |
| `pnpm build`                                    | Build all workspaces                                     |
| `pnpm check`                                    | Run formatting, lint, types, tests, and dead-code checks |
| `pnpm lint`                                     | Run ESLint                                               |
| `pnpm typecheck`                                | Run TypeScript checks                                    |
| `pnpm test`                                     | Run unit tests                                           |
| `pnpm test:e2e`                                 | Run Playwright tests                                     |
| `pnpm db:push`                                  | Push the Drizzle schema to the configured database       |
| `pnpm admin:bootstrap --email user@example.com` | Provision the first operator                             |

Cloudflare commands such as `pnpm cf:preflight`, `pnpm cf:deploy`, and `pnpm cf:smoke` are described
in the [Worker README](./apps/collaboration-do/README.md).

## Operations

- **First operator** – sign in once, then run `pnpm admin:bootstrap --email <you>`; use `/admin` afterwards
  ([admin runbook](./docs/operations/admin-data-retirement.md)).
- **Collaboration Worker** – deploy, rollback, and the `COLLAB_ROOMS_DISABLED` kill switch are in the
  [Worker deployment runbook](./docs/operations/collaboration-do-deployment.md).
- **Cleanup cron** – `POST /api/maintenance/cleanup` with `Authorization: Bearer <CRON_SECRET>`; review
  its retention behavior before enabling the default Vercel schedule (`30 3 * * 1`).

## Documentation

Start with the [documentation guide](./docs/README.md) for architecture contracts, ADRs, operations,
performance budgets, and reusable system-design notes.

## License

[MIT](./LICENSE)
