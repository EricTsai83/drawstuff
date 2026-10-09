# Collaboration threat model and data-flow review

- Status: Current
- System design: [collaboration system design](./collaboration-system-design.md)
- Observability policy: [Durable Object observability contract](../observability/collaboration-do-observability.md)
- Capacity and limits: [collaboration SLO](../performance/collaboration-slo-capacity.md)

This document identifies trust boundaries, data that crosses them, implemented controls, and
accepted gaps.

Collaboration rooms are **not** end-to-end encrypted ([plan 21](../../plans/21-plain-rooms-google-docs-access.md),
owner decision 2026-10-10). Realtime frames, Neon snapshots and UploadThing room assets are
plaintext at rest and in the relay; WSS/HTTPS protects them in transit. Rooms are protected the same
way as "my scenes": sign-in plus the Room DO's access rules. There are no room keys. Only share links
(scene export / shared-scene) remain end-to-end encrypted; they are outside this document's
collaboration scope.

The Room DO is the authorization authority, with Lifecycle retirement and PostgreSQL storage fences;
current boundaries are defined by the [authority contract](collaboration-authority.md). Invitation
email addresses (including addresses without registered accounts), normalized comparison keys,
creator, and timestamps are visible server metadata. They must not be logged or included in
analytics/error reports. Normalization trims outer whitespace and lowercases only; it preserves dots
and plus addressing. Identity proofs do not grant a room role; every entry validates the proof
signature, current lifecycle registration, and local authority, and the role is recomputed from the
owner, invitation list and general access on every check. A SQLite primitive accepting a typed
identity is not a public authentication boundary.

## Trust boundaries

| Boundary | Sides                                | Reachability                                                                              |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| B1       | Browser ↔ Room DO WebSocket (`GET /v1/rooms/:roomId/socket`) | Logged-in users whose short-lived identity proof is accepted and whose computed room role is not none |
| B2       | Browser ↔ collaboration tRPC backend | Logged-in users; every procedure resolves room access                                     |
| B3       | Browser ↔ object-storage upload      | Room owner/editor at the current authority epoch                                          |
| B4       | Web backend → Gateway authority/snapshot/asset/lifecycle routes, and Worker → web adapter (`/api/internal/collaboration/adapter`) | Server-to-server: the Gateway accepts only `COLLAB_AUTHORITY_SECRET`; the web adapter accepts only `COLLAB_ADAPTER_SECRET` (opposite direction, purpose-separated); browser identity or roles are never sufficient |
| B6       | Browser ↔ application-code delivery (HTML/JS served by the `apps/web` origin) | All users; content is decided by anyone able to change the deployment or its build inputs |

Actors are room owner, editor, viewer, logged-in user without access, unauthenticated caller, relay
operator, backend/storage operator, network intermediary, **hosting/deployment operator** (anyone
able to change what the `apps/web` origin serves: Vercel account holders, CI with deploy rights, the
platform itself), and **build-time dependency** (any npm package, including transitives, whose code
runs during build or ships in the bundle). Relay, Neon and UploadThing operators can read room
content (T17); the controls below constrain who can reach it through the product.

## Cross-boundary data

| Data                      | Boundary | Form                                                                            | Readable by                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Scene and presence frames | B1       | Plaintext encoded message with one-byte channel prefix, inside WSS              | Room participants; Room DO (routes without decoding); Cloudflare |
| Identity proof            | B1, B4   | HMAC claims for room, subject, verified email, lifecycle version, protocol version, expiry, audience; no role | Gateway/Room verifier                        |
| Durable snapshot          | B2       | Plaintext `encodeCollaborationSnapshot` bytes, checksum, byte length, revision  | Room participants; web backend; Neon         |
| Asset bytes               | B3       | Plaintext `encodeCollaborationAssetPayload` bytes on a public UploadThing URL   | Anyone holding the URL (ADR-0005)            |
| Asset metadata            | B2       | File ID, byte length, and storage URL                                           | Backend                                      |
| Room lifecycle            | B2, B4   | Owner, invitation list, opened records, link role, revision/epoch, status       | Backend                                      |

Three invariants follow:

1. Room content never enters logs, metrics, error payloads, or analytics; logs carry only the
   closed field set in the observability contract.
2. Authorization comes from the Room DO on every check: an ended room grants nothing; the owner is
   `owner`; an invited email gets the higher of invitation and general-access role; otherwise
   general access decides. Join records never store a role, so closing general access or removing
   an invitation takes effect for people who already joined.
3. Ending a room, removing an invitation, narrowing general access, downgrading an editor
   invitation and leaving fence storage writes (epoch bump) and close affected live sockets
   (`membershipRevoked`, or `roleChanged` when access remains with a different role).

## Untrusted-input controls

### Relay

| Input/resource    | Control                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Control frame     | Measure UTF-8 bytes before JSON parse; max 65,536 bytes                                                   |
| Data frame        | Channel-specific byte bound before any copy or decode (scene 1 MiB, presence 16 KiB)                   |
| Identity proof    | HMAC, audience, room, protocol version, short TTL, current lifecycle registration; role computed by Room |
| Connections       | Per-room Durable Object caps: 32 joined members + 32 pending, 64 sockets hard cap per Object; per-Object isolation replaces the retired Node process-wide caps; explicit close codes and bounded close handshake |
| Lifecycle         | 10s join timeout, 15s heartbeat, 15m idle timeout, deterministic socket/room cleanup                      |
| Backpressure      | 4 MiB outbound cutoff; presence drops above 256 KiB                                                       |
| Scene traffic     | 240 frames/s with burst 480; 2 MiB/s with burst 8 MiB                                                     |
| Presence traffic  | 40 frames/s with burst 80; 256 KiB/s with burst 512 KiB                                                   |
| Join churn        | 10 authorized attempts per subject per minute, bounded subject registry                                   |

Relay subject tracking fails open when its bounded registry is full; the condition is visible in
metrics. This prevents the limiter itself from becoming an unbounded memory sink.

### Web backend and storage

| Input              | Implemented control                                                                                                                                                                                         | Current gap |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Room procedures    | Protected procedure, access resolved by Room authority, room-row and roomId locks for lifecycle writes, no room lifetime (rooms end explicitly), 20 joins/user/minute                                                                       | —           |
| Snapshot put       | Decode/size bound before transaction, checksum, current authority epoch, row lock, optimistic revision, 6 writes/room/minute; after an explicit refusal, leave-only reserve 2 writes/user/room/minute | —           |
| Asset resolve      | Access check, max 64 IDs per batch, 120 lookups/user/minute                                                                                                                                                 | —           |
| Asset upload       | One object/request, size bound, owner/editor role, current authority epoch, max 512 assets/room, 60 presigns/user/minute                                                                                     | —           |
| Ended/expired data | Seven-day grace, bounded idempotent maintenance job, transactional deferred object cleanup                                                                                                                  | —           |

The four entry-point limits and the snapshot leave-only reserve are shared counters in Upstash Redis
(`@upstash/redis` + `@upstash/ratelimit`, sliding window, key prefix
`drawstuff:collab:ratelimit:v1:<operation>`), because `apps/web` runs on serverless functions where
a process-local counter is one limit per warm instance rather than a limit. Approved values are in
[SLO §5](../performance/collaboration-slo-capacity.md); the complete request and degradation flow is
part of the current [collaboration system design](./collaboration-system-design.md).

A rate limit is capacity and abuse protection, not an authorization boundary, so Redis failure
fails **open**: a 750 ms timeout or an SDK exception is reported as `degraded`, the request
proceeds, and a structured event is emitted. Every control in the table above other than the rate
limit stays fail-closed while that is happening — including authentication, room role, authority epoch,
payload and batch bounds, and the 512-assets-per-room cap. `degraded` never becomes
a 429, so it cannot consume a client's retry budget. Each limiter decision makes exactly one Redis
call and is never retried. Ordinary requests make one decision; only a leave snapshot explicitly
refused by the room budget checks the separate two-token finalization reserve, for at most two calls.
No path substitutes a process-local counter, which would present one independent limit per instance
as a global one.

### Client

The join buffer (256 messages/8 MiB), offline queue (2,048 elements/512 KiB/5 minutes), outbound
buffer (4 MiB), inbound pending queue (2 MiB), transfer concurrency and retry attempts are all
bounded. Destroy/switch/leave aborts in-flight
work and releases timers, object URLs, sockets, and caches.

## Threats and current disposition

Room assets are public UploadThing plaintext objects, the same exposure as owned-scene images
([ADR-0005](../adr/0005-public-collaboration-assets.md), plan 21 D6). Asset resolution and
upload/finalize require current room authorization, but the provider does not recheck access on
direct URL downloads. A removed member or anyone else who retains or obtains the permanent URL can
still download that image while the object exists. Enforcement claims cover controlled
application/relay entrances, not invalidation of public object URLs.

| ID  | Threat                                                     | Control or accepted limitation                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Account without access reads room content | Every socket join and every frame recompute the role from the Room DO; snapshot/asset routes require the same authority; initializing rooms admit only the owner; ended rooms admit nobody. |
| T2  | Passive network intermediary reads scene | WSS/HTTPS protect transport. Stored and relayed content is plaintext to the service (T17). |
| T3  | Removed member remains online | The Room DO recomputes access on every frame and closes affected sockets after a management change (`membershipRevoked`; `roleChanged` when the role differs); storage writes are fenced by authority epoch. If the storage fence is not yet confirmed, the result is reported as pending rather than enforced. |
| T4  | Viewer mutates scene                                       | Relay rejects scene frames from viewer sessions; UI read-only state is secondary defense.                                                                                                                                                                                                                                                            |
| T5  | Oversize/buffer abuse                                      | Raw-byte bounds precede decode; connection, room, buffer, queue, replay, asset, and snapshot limits are explicit.                                                                                                                                                                                                                                    |
| T6  | Authorized caller amplifies load                           | Relay traffic/churn limits are implemented. Backend join, snapshot-write, asset-upload and asset-resolve rates are bounded by shared Redis counters that hold across serverless invocations; a real refusal is a 429 with a machine-readable reset, and Redis failure fails open as observable degradation while every hard guard stays fail-closed. |
| T7  | Room link leaks | Accepted: an invitation link is only `?collab-room=<id>` and grants nothing by itself. With general access "only invited people", a leaked link admits nobody new. With a link role, it grants that role to any signed-in account; the owner can narrow general access, which closes link-only sessions immediately. Already-known public asset URLs remain accessible (ADR-0005). |
| T8  | Telemetry leaks content or identity                        | The Durable Object logger (`apps/collaboration-do/src/logger.ts`) is the only sink; fields are a closed type plus a runtime allowlist, pre-verification failures log only enums, and tests pin the field set. Subject IDs, emails, proofs and payloads are never logged.                                                                      |
| T9  | Ended room retains content or personal data forever | Room cleanup deletes snapshots and assets when the room ends; a seven-day-grace maintenance job is the backstop. Neon keeps only the room row (ended, empty label) and creation fence; member/invite projections, tombstones, operation receipts and lifecycle registrations are purged. The Room DO deletes all of its storage once settled. |
| T10 | One format-version change destroys unrelated durable data | Transport, snapshot and asset payload formats are versioned independently; isolated corruption remains non-terminal. |
| T11 | Oversize local change silently stops sync                  | Client exposes a clearable blocked state and stops claiming synchronization until content is reduced.                                                                                                                                                                                                                                                |
| T12 | Fanout state is accidentally split across instances | Structurally eliminated by the Durable Object architecture: each `roomId` maps to exactly one `CollaborationRoomV2` Object (`getByName(roomId)`) whose single-instance placement is platform-guaranteed; no process-wide room map exists. |
| T13 | Client-selected identifier pollutes logs | Eliminated at the source: there is no `clientId`; join carries room and identity proof, peer identity is the Object-created `peerId`. Before proof verification even `roomId` is not logged. |
| T14 | Stale or unauthorized client seeds or overwrites snapshot | Only the owner completes initialization; writes require owner/editor role, the current authority epoch and `expectedRevision`; a missing or unreadable baseline is never treated as an empty room. |
| T15 | Relay suppresses frames                                    | Accepted availability limitation. A relay can always drop or refuse traffic, and a quiet room is indistinguishable from suppression without false positives. Metrics expose routing inactivity; confidentiality is unaffected.                                                                                                                       |
| T16 | Modified application bundle exfiltrates data | **Accepted limitation.** JavaScript served over B6 reads room content and share-link keys, so anyone who decides that code's content can read them: (1) a hosting/deployment operator, (2) a build-time supply-chain compromise in any npm dependency, (3) runtime injection (XSS or any path that executes script in the document), (4) network-level rewriting where TLS is bypassed or a certificate is mis-issued. Implemented controls raise the bar without removing it — see [Code delivery (B6) controls](#code-delivery-b6-controls). |
| T17 | Service operator reads room content | **Accepted by design** (plan 21 D1). Room DO, Neon and UploadThing operators — and anyone who compromises those stores or the Worker — can read room content, as with "my scenes". Controls: sign-in and Room DO access rules on every entrance, server-to-server secrets in the Worker secret store, no content in logs, metrics or errors, and deletion after a room ends. |

## Code delivery (B6) controls

None of these controls prevents an operator who can change the served bundle from reading room
content or share-link keys (CLAIM-CDB-1 in [ADR-0004](../adr/0004-code-delivery-trust-boundary.md)); they narrow
exfiltration outlets, shrink the injectable surface, and keep the deployed code auditable. The
rollout checklist and standing requirements live in
[CSP verification and deployment](../operations/web-security-headers.md).

- **Exfiltration-outlet convergence (CSP `connect-src`)**: the browser may open network
  connections only to the app origin, the relay origin, UploadThing's ingest/file hosts, and the
  official Excalidraw library host. `apps/web/src/config/security-headers.ts` is the single
  source; `apps/web/tests/security-headers.test.ts` pins the allowlist, rejects wildcard
  origins, and keeps dev relaxations out of production. CSP does not stop exfiltration to an
  allowlisted origin, including our own.
- **Asset self-hosting**: `window.EXCALIDRAW_ASSET_PATH` points canvas fonts and CJK subset
  assets at the app origin (`scripts/sync-excalidraw-assets.mjs`), so esm.sh is never
  contacted in normal operation and is not allowlisted. Upstream still appends its esm.sh URL
  as a last-resort candidate that is tried only after a self-hosted fetch fails; under an
  enforced CSP that residual error path is blocked by `font-src 'self'`/`connect-src`.
- **Embed restriction**: embeds whose upstream implementation executes third-party scripts with
  page-origin privileges (twitter/x, reddit, gist) are rejected by the embed validator, and CSP
  `script-src` carries no external origin. `frame-src` equals the remaining iframe-only embed
  hosts exactly (`apps/web/src/config/embed-allowlist.ts`).
- **Build-time supply chain**: CI installs with `--frozen-lockfile --trust-lockfile`; `pnpm
  audit:ci` gates production dependencies; `pnpm-workspace.yaml` pins vulnerable transitives via
  `overrides` and denies postinstall scripts for esbuild/sharp/msgpackr-extract/unrs-resolver via
  `allowBuilds`; all GitHub Actions are pinned to full commit SHAs. Production dependencies
  include no third-party analytics or monitoring browser SDK; adding any third-party browser
  script is a reviewed decision. The dev-only unpkg `react-grab` script never enters the
  production CSP.
- **Collaboration package dependency boundary**: `packages/collaboration/tests/package-contract.test.ts`
  pins the collaboration package's runtime dependencies to exactly `["zod"]`, restricts
  `node:crypto` to the server-only identity-proof module, and asserts the package carries no room
  key material.
- **Deployment path**: `apps/web` deploys only through the Vercel git integration from reviewed
  commits on a protected branch; no long-lived deploy token can replace the bundle from CI. The
  Cloudflare Worker deploy path cannot change the browser bundle (not T16), but it can read room
  content in transit and in Room DO storage, so its compromise is T17 as well as T15/T3 surface. See [CSP verification and deployment](../operations/web-security-headers.md) for the standing
  requirements.

## Observability data classification

Allowed fields are opaque `roomId` after verification, Object-created `peerId`, role,
byte counts, frame counts, channel enum, close/disconnect enums, aggregate conflict counts,
snapshot revision, latency, event-loop lag, and memory. The backend rate limiter's degradation event
adds two closed enums — the operation and the cause (`timeout` or `exception`) — and nothing else:
it carries no identifier, no Redis endpoint, and no error payload, because an Upstash SDK error
message embeds the REST URL and the token it was called with.

Forbidden fields are email, display name/presence username, message content, payload bytes or
base64 fragments, payload-derived error details, share-link keys, token or token fragments,
snapshot bytes, and raw subject ID.

Metrics intentionally omit room and peer identifiers to prevent enumeration and cardinality growth.
Logs may use verified room/peer IDs, but token failure before verification records only a closed enum.
Raw subject ID is replaced with a 48-bit per-process HMAC pseudonym so it cannot be correlated across
relay restarts.

## Accepted monitoring limitations

Relay metrics and structured logs are implemented. Session-success, browser decode-failure, and
snapshot-conflict SLOs currently have a defined privacy-safe carrier contract but no implementation,
so those three SLO thresholds cannot drive alerts. Telemetry, if added, must use authenticated,
bounded backend aggregation rather than a new untrusted relay channel.

## Administrative data retirement

Production operators can retire another user's scene, room, or account through a narrowly scoped
server API. This is intentionally a privileged capability: a compromised operator session could
destroy user data or terminate live collaboration sessions.

- Better Auth establishes the caller's stable user ID; an active DB-backed `admin_grant` authorizes
  the operator. Email and client-side UI state are not request-time authorization inputs.
- Every endpoint uses `adminProcedure`, accepts only a concrete target identifier, and reuses the
  same lifecycle services as owner-initiated deletion. There is no impersonation or arbitrary-query
  endpoint.
- Account retirement cannot target the active administrator and requires the target ID twice.
- Every accepted operation persists audit intent before execution and records success/failure in
  `admin_audit_event`, without scene content. Audit rows survive target
  account deletion.
- Every scene/account cascade follows durable Lifecycle freeze and all Room storage-fence acknowledgments. Account freeze revokes sessions; local Room tombstones close sockets and refuse delayed activation. Pending leaves deletion unfinished. Workspace deletion rechecks that every source scene has retired before cascade. Better Auth self-delete is explicitly disabled.
- Storage deletion failures enter `deferred_file_cleanup`. Capability separation prevents identity proofs from invoking Lifecycle or the storage adapter. Management exposes bounded invitation/member pages to owners only, with identical add-email behavior for registered and unregistered addresses. No production controls changed during P2.
