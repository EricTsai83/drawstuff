# Collaboration system design

- Status: Current
- Generalized patterns: [realtime room coordination](../system-design/realtime-room-coordination.md),
  [E2EE key lifecycle](../system-design/e2ee-key-lifecycle.md),
  [transactional outbox](../system-design/transactional-outbox.md),
  [defensive boundaries](../system-design/defensive-boundaries.md)
- Security model: [collaboration threat model](./collaboration-threat-model.md)
- Capacity contract: [collaboration SLO](../performance/collaboration-slo-capacity.md)
- Deployment contract: [Durable Object deployment runbook](../operations/collaboration-do-deployment.md)

This document describes the collaboration system as it exists today. The relay is a Cloudflare
Worker gateway plus one `CollaborationRoom` Durable Object per room generation
(`apps/collaboration-do`); durable collaboration data belongs to the web backend; encryption and
reconciliation run on clients.

## Components and data flow

```text
browser
  ├─ native elements ─→ @drawstuff/excalidraw-adapter (official reconcile semantics)
  ├─ encrypted realtime frames ⇄ collaboration relay (opaque bounded fanout)
  └─ encrypted snapshot/asset requests ⇄ apps/web
                                           ├─ shared limit decisions ⇄ Upstash Redis
                                           └─ durable data ⇄ PostgreSQL/object storage
```

`@drawstuff/collaboration` owns transport-neutral messages, validation, crypto, ordering, join
barriers, offline queues, and recovery policy. `apps/web` binds those contracts to authenticated
room APIs and the editor. The relay imports only server-safe protocol entries; it cannot decrypt or
persist a scene.

Upstash stores expiring rate-limit window state only. It receives canonical user/room identifiers
used as counter keys, but no room key, plaintext scene, ciphertext snapshot, asset bytes or storage
capability. PostgreSQL and object storage remain the only durable collaboration stores.

Scene messages contain native syncable elements. Presence is volatile and independent from scene
delivery. Binary asset bytes never travel inside scene messages.

## Identity, authorization, and room lifecycle

- `roomId` is created by the backend and maps to a `collaboration_room` row.
- `peerId` is created by the relay for each connection and is the only collaboration peer identity.
  Reconnect creates a new peer and rebuilds the cursor, matching upstream socket identity behavior.
- There is no client-selected `clientId`. Join frames contain only room and token.
- Roles are `owner`, `editor`, and `viewer`. Authorization resolves in this order: owner, active
  member row, link role, denial. Anonymous joining is disabled.
- The backend issues short-lived HMAC join tokens after access resolution. Tokens bind room,
  subject, role, authorization generation/revision, room expiry, and audience; they never contain
  room keys.
- The relay verifies the token before joining a channel. Viewers cannot publish scene frames.
  Revocation advances a cutoff and disconnects existing sessions; room expiry also bounds live
  sessions.
- Authorization revocation and cryptographic revocation are separate. Removing a member blocks
  future access but cannot erase a key already learned. Generation rotation changes the channel,
  key derivation salt, verifier, and durable-data generation.

Room mutation paths lock the room row, re-evaluate authorization, insert the enforcement intent
into the durable control outbox (`collaboration_control_outbox`) in the same transaction, and
commit. This serializes token issuance with membership, end-room, and generation changes, and makes
the authorization state and its enforcement intent inseparable. After the commit, one synchronous
best-effort dispatch gives fast UI feedback; anything unenforced stays `pending` and is drained by
a dedicated minute-level schedule (`/api/collaboration/control-outbox`, fired by the collaboration
Worker's Cloudflare cron trigger because the Vercel deployment's Hobby-plan crons are daily-only;
the weekly storage cleanup stays a Vercel cron) with claim leases, exponential
backoff with jitter, a poison-event terminal state, and bounded retention. A gateway `422`
carrying the `control-rejected` body is a deterministic refusal and moves the event to `failed`
on that attempt; every other non-2xx, timeout, or transport error stays retryable. Deliveries are
revision-max idempotent on the Durable Object, so ambiguous timeouts are resent safely. No signed token
is stored; every delivery signs a fresh short-lived control token. Mutation responses distinguish
`enforced` (the Durable Object confirmed closing sockets) from `pending` (committed, delivery queued).

### Durable Object-only realtime routing

Every room generation maps to exactly one `CollaborationRoom` Durable Object. `join` signs a fresh
token under the room lock and returns a generation-scoped opaque `relayUrl` composed from the
server-only `COLLAB_CONTROL_URL` (its http(s) origin mapped to ws(s)); clients receive no provider
discriminant and have no fallback path.
Control outbox events always dispatch to `COLLAB_CONTROL_URL`. Neither room nor outbox rows store a
provider, and there is no percentage/cohort policy or Node dispatcher. The durable outbox is a
permanent correctness mechanism.

The fail-closed `COLLAB_ROOMS_DISABLED` operational switch refuses `create`/`join` with an explicit
SERVICE_UNAVAILABLE while leaving lifecycle mutations available so owners can still shut rooms
down.

## Protocol and delivery semantics

Every network payload is byte-bounded before strict runtime decoding. Transport protocol version is
independent from native document and durable payload versions.

A join whose `protocolVersion` differs from the relay's `COLLABORATION_PROTOCOL_VERSION` — in
either direction — is refused with `unsupportedProtocolVersion` (4013), never with the generic
`protocolViolation`, and the close reason names both versions so the skew is visible in close
records. The client treats that refusal as deploy skew rather than as a defect: `apps/web` and the
Worker both auto-deploy from `main` and land minutes apart, so after a protocol bump either side can
be ahead of the other. Recovery retries the refusal with backoff for a bounded wall-clock window
(`DEFAULT_PROTOCOL_SKEW_WINDOW_MS`, five minutes) that is charged to the window rather than to the
ordinary retry budget, and only once the window closes does it fail with the terminal
`unsupported-protocol-version` reason whose remedy is a reload — the case of a tab left open across
a bump. No deploy ordering between web and Worker is required for a protocol bump.

The relay provides session ordering, not durable or exactly-once delivery. Scene and presence use
separate channels:

- scene frames are reliable within a live socket session and are rejected when sender role or
  limits disallow them;
- presence may be dropped under backpressure; besides pointer/selection/idle it carries the
  sender's visible scene bounds, absolute zoom, and follow target, which is all follow mode needs —
  the relay has no follow rooms. Follow relations stay acyclic client-side: the newest follow edge
  wins and the oldest edge in a cycle releases (`apps/web/src/lib/collab/session/follow-mode.ts`);
- ordering/idempotency uses `(senderPeerId, sequence)` and the current room generation;
- reconnect gaps are repaired through full-scene synchronization, durable snapshot, and official
  reconciliation rather than replay state in the relay.

All socket buffers, inbound queues, replay caches, offline queues, timers, and reconnect attempts
have explicit limits. Oversize, capacity, slow-consumer, authorization, rate, idle, and restart
outcomes use distinct close reasons so clients can distinguish terminal from retryable failures.

## End-to-end encryption and key confirmation

The URL fragment holds a random 32-byte room key; it is never sent to the backend or relay. HKDF
derives purpose-scoped keys for `realtime`, `snapshot`, `asset`, and `keycheck`, salted by room and
authorization generation. Each format has its own version and authenticated-data label.

Scope of the guarantee: E2EE holds against passive relay/backend/storage operators, a database
leak, and network intermediaries — none of them ever holds a key. It does not hold against whoever
controls the application code the browser runs, because the key lives in that code's memory. That
boundary (B6) and its accepted limitation (T16) are defined in the
[threat model](./collaboration-threat-model.md); no claim in this document extends to a modified
application bundle.

- Realtime uses AES-GCM with a fresh random 96-bit IV per message and an enforced per-sender seal
  budget. Its AAD includes the transport version because realtime frames are transport data.
- Snapshot and asset AAD do not contain transport version. Their payload and envelope versions
  evolve independently, so a realtime protocol change cannot invalidate durable ciphertext.
- The room row stores a fixed-size encrypted key-check value. Clients verify it before taking over
  or clearing the canvas and before requesting a join token. Its AAD and derived key bind room and
  generation. Missing checks fail closed, and the server also refuses to issue a join token.
- A verifier cannot change inside one generation. Rotation clears it and the owner recomputes it
  with the new key. The owner can explicitly reset an unreadable snapshot after confirmation.
- Every collaboration text boundary — the share-link room key, the key-check value, join/control
  token segments, and snapshot ciphertext over tRPC — goes through one shared canonical codec,
  `@drawstuff/collaboration/base64`. Each format has exactly one profile (standard Base64 with
  RFC 4648 canonical padding; Base64URL always unpadded; zero unused trailing bits; no
  whitespace), decode returns a closed result (`malformed` / `oversize`) instead of surfacing host
  exceptions, and the encoded length is bounded before any allocation. Encoding feature-detects
  the native TypedArray Base64 API and falls back to a chunked `btoa`/`atob` path; both paths are
  held to identical output by tests in Node, Chromium, WebKit, and workerd (pinned compatibility
  date), which together with the fixed room-token vectors formed the wire-format precontract for
  the completed Durable Object migration
  ([ADR-0002](../adr/0002-collaboration-durable-object-target.md)). Realtime frames stay binary;
  Base64 never enters the WebSocket hot path. The measured 4 MiB snapshot budget lives in the
  [SLO document](../performance/collaboration-slo-capacity.md).

Individual corrupt realtime frames and assets are dropped without terminating a healthy session.
To avoid a silently empty room under a wrong key, realtime open failures are aggregated: three
failures with no successful open arm an unreadable-room verdict after the in-flight cohort settles.
One successful open permanently disables that verdict for the transport. Assets apply the same
"failure with no success" distinction for user-visible room status while irrecoverable individual
images are marked `error` and the scene continues.

## Join bootstrap, snapshots, and recovery

Joining subscribes before loading a baseline. Inbound scene messages are held in a bounded join
barrier while an elected peer snapshot and durable snapshot race; the first valid baseline wins,
then buffered messages replay in order and reconcile. The client must never fetch first and
subscribe later.

Only an editor/owner selected deterministically by lowest `peerId` responds to sync and writes
snapshots. Snapshots contain syncable elements only—no presence, viewport, selection, collaborators,
or binary bytes. They are encrypted client-side and stored as one optimistic-revision row per
room/generation. A client that does not know a valid baseline cannot overwrite it.

Snapshot writers merge the winner after a revision conflict before retrying. Periodic cadence and
forced leave flush share authorization, role, generation, baseline-known, and revision guards. The
flush evaluates those guards and captures the scene *before* it waits on anything: teardown closes
the transport in the same tick the flush is requested, and the write itself travels over tRPC, so a
guard consulted after an await would veto the one write that persists the room's last edits. A
session that reaches a terminal recovery state clears its own connection state, timers, and
collaborator cursors and refuses further snapshot writes — it never depends on the transport
announcing the disconnect, synchronously or at all.

Remote canvas writes run inside the host's dirty-tracking suppression, which is reference-counted:
overlapping windows (element applies resume a frame later; other suppressors may be open in the
same frame) release exactly one hold each, never each other's. Presence-only writes take a separate
synchronous window — at ~30fps per peer, frame-deferred windows would overlap continuously and a
local edit would never mark the scene dirty.

Joining a room claims the tab's canvas independently of cloud scene ownership; a guest never saves
over the owner's scene. The claim is committed in this order:

1. Fetch room metadata and verify the fragment-held key against the generation's key check. A bad
   or incomplete link stops before changing the canvas or minting a token.
2. If the room's owned scene is not already open, resolve local work through the existing
   save/discard/cancel prompt, clear the scene session and empty the canvas. Retries never repeat
   this preparation.
3. Mint the join token through the bounded rate-limit-aware join call, then verify that the returned
   authorization generation is still the one whose key check passed.
4. Claim the canvas in tab-scoped storage and only then construct the session and open the socket.
   No inbound frame can exist before this point.

A refused join, an exhausted retry budget, or a generation race therefore leaves no collaboration
claim. If session construction fails after the claim, that start path releases the claim and every
partially built resource — the transport subscription, the socket, the asset store — immediately.
A bootstrap join failure is classified from the backend's error code, exactly like a reconnect
refusal: only a stated `UNAUTHORIZED`/`FORBIDDEN` verdict reads as an authorization problem, an
ended room reads as the room ending, and everything else (network, 5xx, crypto, construction) is
reported as a retryable join failure with a translated message, never the raw error text.
Replacing or clearing the canvas also releases the claim and tears down collaboration-owned
resources. Canvas preparation is still a user-approved commit: if the user chose to discard local
work and the later join fails, the system does not reconstruct the discarded canvas.

Recovery classifies disconnects into terminal, retryable, and generation-rotation outcomes. A
bounded exponential backoff reconnects, obtains a new `peerId`, rebuilds presence, and uses the same
join barrier to converge. Relay restart never touches PostgreSQL or owned-scene state.

## Shared backend rate limits

### Why the counter is a separate shared service

Relay-side connection and frame token buckets live inside the room's single Durable Object, which
serializes its own state, so per-room counters there are correct. `apps/web` runs in serverless
functions: a process-local counter there
would be one independent limit per warm invocation and would change strength whenever the platform
scaled. Backend entry-point limits therefore use one module-scoped `@upstash/redis` client and
`@upstash/ratelimit` sliding windows in Upstash Redis.

Redis credentials are server-only deployment configuration. Missing or malformed credentials fail
environment validation before serving requests. Once a deployment is correctly configured,
request-time Redis failure follows the fail-open contract below.

The limiter owns the versioned namespace
`drawstuff:collab:ratelimit:v1:<operation>`. The SDK owns window expiry and key cleanup;
`ephemeralCache` is disabled so no warm function instance can answer authoritatively from local
memory. An incompatible algorithm or key-meaning change requires a new namespace version.

| Operation           | Canonical identifier        | Sliding window | Protected work                                                      |
| ------------------- | --------------------------- | -------------- | ------------------------------------------------------------------- |
| `join`              | authenticated `userId`      | 20/minute      | Room lookup, access resolution and join-token minting               |
| `snapshot-put`      | resolved canonical `roomId` | 6/minute       | Room lock, authorization transaction and conditional snapshot write |
| `snapshot-finalize` | canonical `(roomId,userId)` | 2/minute       | Leave snapshot after the normal room budget explicitly refuses it   |
| `asset-upload`      | authenticated `userId`      | 60/minute      | UploadThing presign, storage upload and asset commit                |
| `asset-resolve`     | authenticated `userId`      | 120/minute     | Room lookup and bounded asset-location batch                        |

Identifiers come from authenticated or already-resolved server state, never from a caller-selected
rate-limit key. User-scoped checks run after authentication and input validation but before room
lookup. Snapshot ciphertext is decoded and size-bounded first; then an unlocked pre-access and
editor-role check resolves the canonical room before spending its room budget. The actual snapshot
authorization is repeated under the room lock in the write transaction, so the limiter placement
does not weaken revocation or generation races.

Asset upload is counted only on the authenticated client presign POST. UploadThing callbacks and
error hooks use the same route but do not spend the budget: they are storage-provider traffic, and
counting them would let a successful upload charge itself more than once. The wrapper owns the 429
because UploadThing 7.7.4 cannot represent `TOO_MANY_REQUESTS` from FileRoute middleware without
turning it into the wrong HTTP status.

### Decision and degradation flow

```text
authenticated + structurally valid request
  └─ primary shared limiter decision (one Redis call, no retry)
       ├─ allowed  ───────────────→ authorization/hard guards → protected work
       ├─ degraded ───────────────→ authorization/hard guards → protected work
       └─ limited
            ├─ ordinary request ──→ HTTP 429 + reset metadata
            └─ leave snapshot
                 └─ finalization decision (one Redis call, no retry)
                      ├─ allowed/degraded → authorization transaction → write
                      └─ limited          → HTTP 429 + reset metadata
```

Each limiter decision makes exactly one SDK call, and the Redis transport has retries disabled.
Ordinary requests therefore make one Redis call. Only a leave snapshot whose primary room budget
returns an explicit refusal can make a second call against the finalization reserve. A timeout is
`degraded`, not `limited`, so it proceeds without checking the reserve.

The limiter timeout is 750 ms rather than the SDK's five-second default. Timeout, network error and
SDK exception fail open and emit one structured `collab.ratelimit.degraded` event containing only
the closed `operation` and `cause` enums. They never expose an identifier, endpoint, credential or
raw SDK error. Rate limiting is capacity and abuse protection, not an authorization boundary:
authentication, room role, current generation, payload and batch bounds, the 512-assets-per-
generation cap, row locks and conditional revisions all continue to fail closed.

No local fallback is installed during an outage. It would look shared while actually producing a
different answer in each serverless instance. There is also no inline retry: retrying an ambiguous
non-idempotent counter operation could spend multiple tokens and would amplify latency during the
incident the timeout is intended to contain.

### Leave snapshot finalization reserve

`collaborationSnapshot.put` carries `intent: "cadence" | "leave"`; omitted intent defaults to
`cadence` for compatibility. Intent is an untrusted scheduling hint, not proof that a tab is
actually closing. Every request first checks the normal six-per-minute room budget. Only an
explicit normal-budget refusal plus `leave` reaches `snapshot-finalize`, keyed by the canonical room
and authenticated user.

The reserve has two tokens per user-room per minute: one for the captured final scene and one for
the existing single conflict-merge retry. Calling every write `leave` therefore buys only two
bounded extra attempts, never a bypass. All ordinary role, generation, baseline-known and
optimistic-revision guards still apply, and a second reserve refusal is returned as 429.

Forced flushes intentionally ignore the client's cadence cooldown and writer election. They wait
for an in-flight cadence write, capture the canvas once, survive synchronous React teardown, and on
conflict load and merge the winner before one retry. This closes the reproducible case where the
last participant leaves after the room cadence budget is exhausted. It does not guarantee delivery
if the browser process is killed, the device is offline, or the request never leaves the process;
the project deliberately does not add IndexedDB pending snapshots, Background Sync, or a durable
client job queue for that residual side-project risk.

### 429 and client scheduling contract

A real refusal is `TOO_MANY_REQUESTS` and carries machine-readable `reset` and `retryAfterMs` data.
tRPC also sets `Retry-After`; the UploadThing wrapper returns the same semantics in an app-owned,
non-cacheable JSON body. Human-readable messages are never parsed to drive scheduling.

- Bootstrap join retries only machine-readable rate limits, waits until the server deadline, and
  counts the first call within a maximum of three attempts. Teardown cancels the wait. Exhaustion is
  reported as `rate-limited`, not `unauthorized`, and occurs before the canvas claim.
- Reconnect folds the server deadline into the existing bounded recovery backoff; it does not grant
  an extra attempt or create an unbounded retry loop.
- Snapshot cadence records a `notBefore` deadline and skips ticks inside the refused window. A leave
  flush still attempts because it has the separate bounded reserve described above.
- Asset resolve and upload track deadlines per file. One rate-limited file cannot pull unrelated
  files back inside their windows, and the existing bounded retry/concurrency limits remain the
  outer cap.

### Verification and deployment boundary

Configuration, decision states, request ordering, 429 transport metadata, client scheduling,
cross-invocation semantics and TTL cleanup are covered with SDK configuration inspection, mocked
Redis responses, an in-memory shared-window model and process-local PGlite databases. Tests never
read or mutate the operator's Upstash or PostgreSQL data.

There is currently no isolated Redis database for a live integration smoke test. Consequently the
suite does not independently prove deployed credentials, real Upstash network behavior, or a real
key expiring across separate serverless processes. Exercising those claims against the operational
database is intentionally deferred until a disposable database and test-only key prefix exist.
This is an accepted verification boundary, not permission to use production data as test state.

A timed-out Redis request may have executed server-side even though the application proceeded as
`degraded`, leaving at most one ambiguous token for that decision. Transport retries are disabled,
so the ambiguity is not multiplied. Eliminating it would require an idempotency protocol whose
complexity is not justified for this self-hosted side project.

## Encrypted assets

Asset identity is `(roomId, authGeneration, excalidraw_file_id)`. Elements travel through realtime;
encrypted bytes use object storage and the web API. The backend stores only the storage locator,
crypto version, and ciphertext byte length. MIME type and data URL remain inside ciphertext.

Resolve requests are bounded batches. Client upload/download concurrency, retry chains, remembered
IDs, response bodies, and in-flight tasks are bounded and abortable. A storage URL is a capability,
not durable identity. Missing assets retry; malformed or undecryptable assets are abandoned and
marked unavailable without blocking element convergence.

Writing a newer generation retires older asset rows in the same transaction and enqueues their
object keys in `deferred_file_cleanup`. Full room and owned-scene retention behavior is defined in
[data lifecycle](./data-lifecycle.md).

## Current operational boundaries

- Realtime fanout is isolated per `RoomChannelKey` in a Durable Object; the thin Worker gateway
  validates tokens and derives Object identity.
- Durable Object connection/frame limits and the shared backend limits described above are implemented.
  WAF or edge rate limiting remains a possible additional layer, not part of the current contract.
  See [SLO §5](../performance/collaboration-slo-capacity.md), the
  [threat model](./collaboration-threat-model.md), and the
  [observability contract](../observability/collaboration-do-observability.md).
- Workers Logs and privacy-safe structured logs exist. Client/session success, decrypt-failure,
  and snapshot-conflict SLOs currently have no telemetry carrier.
- Direct cutover has no Node fallback or percentage rollout; the global create/join kill switch is
  the incident boundary. There is still no staging environment, formal
  capacity load test, or complete incident runbook. These are accepted operating limits for the
  current personally operated, limited-public-test service.
