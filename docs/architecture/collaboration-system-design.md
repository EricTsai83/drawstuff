# Collaboration system design

- Status: Current (protocol 7, plan 21, deployed 2026-10-10)
- Generalized patterns: [realtime room coordination](../system-design/realtime-room-coordination.md),
  [transactional outbox](../system-design/transactional-outbox.md),
  [defensive boundaries](../system-design/defensive-boundaries.md);
  [browser-side encryption and key lifecycle](../system-design/e2ee-key-lifecycle.md) applies to
  share links only — collaboration rooms are not end-to-end encrypted
- Access and retirement contract: [collaboration authority](./collaboration-authority.md)
- Storage UX contract: [collaboration storage](./collaboration-storage.md)
- Security model: [collaboration threat model](./collaboration-threat-model.md)
- Capacity contract: [collaboration SLO](../performance/collaboration-slo-capacity.md)
- Deployment contract: [Durable Object deployment runbook](../operations/collaboration-do-deployment.md)
- Open acceptance issues: [18D](../../plans/18d-collaboration-acceptance-follow-ups.md)

Collaboration rooms are protected like owned scenes: sign-in plus access rules. Realtime frames,
Neon snapshots and room images are plaintext; WSS/HTTPS protects transport, and room images are
public UploadThing objects with the same exposure as owned-scene images
([ADR-0005](../adr/0005-public-collaboration-assets.md)). Only share links remain end-to-end
encrypted.

## Room authority

One `CollaborationRoomV2` Durable Object per `roomId` (`apps/collaboration-do`) is the only
authority for room access. The previous `CollaborationRoom` class is tombstoned in the wrangler
`exports` (`state: "deleted"`), which deletes its storage on deploy. PostgreSQL holds snapshots,
asset records, storage fences and list projections; projections never authorize.

- `packages/collaboration/authority` defines strict identity-only proofs, immutable content
  operations, query/cancel/fence commands, initialization manifests, monotonic projection events,
  stable list cursors, management outcomes, and subject-scoped retirement commands. Proofs grant
  identity, not a caller-selected role. HMAC signing (`signIdentityProof`) stays in the
  server-only `room-token` module.
- `RoomAuthority` owns SQLite room state (`initializing`, `ready`, `ended`), owner, general access
  (`linkRole` `none`/`viewer`/`editor`), the invitation list (normalized email + `editor`/`viewer`),
  opened records, retirement decisions, authorization revision, storage epoch, immutable operation
  metadata, and initialization progress. Opened records hold only subject, email, lifecycle version
  and `last_joined_at`; they never store a role.
- The role is computed on every check: ended or denied → none; initializing → owner only; owner →
  `owner`; invited email → the higher of the invitation role and general access; otherwise general
  access. Commands are `create`, `join`, `set-link-role`, `allow-email`, `remove-email`,
  `complete-initialization`, `cancel-initialization`, `end-room` and `leave`; the full contract is
  in the [authority contract](./collaboration-authority.md). Only changes that can shrink access
  advance the storage epoch (fence): narrowing general access, downgrading an editor invitation,
  removing an invitation, `leave`, and ending the room. Stale-epoch writes fail with
  `epoch-mismatch`.
- Initialization completion stays pending until the adapter confirms the declared latest snapshot
  and complete finalized asset manifest. A terminal local transition cancels completion work,
  rejects late finalization, and durably retains fence and orphan-cleanup work. An empty ready
  room has no TTL or heartbeat.
- `DurableWork` commits business state, operation results, jobs, and the alarm in one local storage
  transaction. External delivery runs outside that transaction, with a 16-job/5-second alarm budget,
  a cancellation signal, bounded persistent backoff, and version-checked acknowledgments. Terminal
  results expire after 24 hours. Room work still undelivered 24 hours after it was first scheduled is
  abandoned (`authority.work_abandoned`): local records become terminal (content receipts
  `refused`, fence-waiting management results get `terminal_at`) without claiming remote success.
  Lifecycle retirement work is never abandoned. No job stores snapshot or image bytes.
- Ordinary work is capped at 128 jobs and safety reserve at 64. Exhausted reserve durably denies
  the whole room, retaining one emergency room fence and at most one emergency orphan-cleanup
  job. Safety mutations that outrun ordinary projections retain a dirty cursor and rebuild
  projections in bounded batches. The invitation list is capped at 200 entries. Initialization
  allows the 512-asset room limit; individual metadata jobs are capped at 64 KiB. Management/content
  result stores each cap at 4,096 entries and refuse new work until capacity is available.
- An ended room whose fence, cleanup and projections are delivered (or abandoned), with no socket
  and no in-flight RPC, calls `deleteAll()` and `deleteAlarm()` (`room.storage_released`). A
  request that leaves no room behind (never created, failed create, stray call after release)
  releases the schema it created the same way. The DO keeps no ended tombstone; Neon does.
- `CollaborationLifecycle` has a SQLite-backed binding per account/scene. `LifecycleProgress`
  persists freeze, cursor enumeration, per-room enforcement, deletion, and completion. It
  retains the terminal subject decision and compares a local progress revision after every
  external response so late results cannot move retirement backwards. Adapter calls deduplicate
  by the original operationId and lifecycle version. A completed retirement object releases its
  storage one hour after completion; a late `begin` re-runs idempotently.
- PostgreSQL room rows need no scene and have no expiry. The partial unique scene index covers
  initializing/ready rooms; an optional scene FK cascades only after retirement confirms the room.
  Pre-activation lifecycle registration has no room FK, so a still-creating room cannot be omitted.
  List projection indices use `(userId, listedAt, roomId)`. After a room ends, Neon keeps only the
  room row (`status='ended'`, empty label) and its `collaboration_creation_fence`; member and invite
  projections, projection tombstones, operation receipts and lifecycle registrations are purged
  (projection self-cleaning, adapter cleanup, maintenance retention, and account/scene deletion).
  Creating a room refuses any roomId that was ever used. Registration, parent creation, storage
  fences, cleanup and purges serialize on a per-roomId advisory lock (account/scene → roomId lock →
  room row).

## Storage and projection adapters

`POST /api/internal/collaboration/adapter` accepts only the private `COLLAB_ADAPTER_SECRET` bearer
capability; unset configuration refuses all requests before body parsing. Browser sessions,
identity proofs and caller-supplied roles do not authenticate this endpoint. Content storage
helpers require an already-persisted room parent.

- `authority-storage.ts` locks the room row for writes, cancellation, result query, reads,
  initialization checks, cleanup and fence advancement. Snapshot effects and immutable operation
  receipts commit together. The fingerprint includes the entire parsed intent, including actor,
  deadline and asset descriptor. Replays return the original outcome/revision; changed intent is
  rejected, including concurrent UUID reuse across rooms. Missing receipts are pending, not proof
  of cancellation. Expired original writes and old epochs cannot write after receipt pruning.
  Terminal receipts are pruned in bounded batches after 24 hours; pending rows remain. Writes and
  registrations for an ended room are refused without leaving records.
- `storageState` and `authorityEpoch` are adapter fence state, independent from display
  projections. A fence waits for earlier room-locked writes to commit. Terminal storage state
  cannot reopen; its first transition also marks the room ended and clears its label. A snapshot
  reset retains a revision high-water so revision zero does not become valid again.
- Initialization verification checks the latest declared snapshot and all declared finalized
  assets under the same lock. It does not make the Room ready. A subsequent snapshot write
  invalidates that verification; promoting adapter state to ready requires a current confirmation.
- Snapshot writes use an octet-stream body plus a strict command header capped at 8 KiB. Other
  commands use bounded JSON bodies (64 KiB), including initialization manifests. Streamed snapshot
  bytes are bounded at the 4 MiB snapshot ceiling independently of Content-Length, and their
  checksum is checked before the write commits. Snapshot reads return binary bytes plus
  revision/checksum metadata and `no-store`.
- Finalization trusts only provider metadata supplied by the authenticated upload delivery path,
  keys assets by `(roomId, excalidraw_file_id)`, bounds assets per room, and queues rejected or
  duplicate unreferenced provider keys for cleanup in the same transaction. Provider-key advisory
  locks serialize new references and orphan-cleanup decisions across rooms. Existing references
  are never queued as orphans, and keys already queued for deletion cannot become new references.
- `authority-projection.ts` conditionally applies per-subject versions (with `access`
  `owned`/`invited`/`link`) and email-keyed invite projections (`collaboration_room_invite`,
  adapter command `project-invite`), plus persistent negative tombstones, without changing the
  storage fence. It ignores obsolete events, rejects parent-deleted/frozen accounts, and deletes
  rows for an ended room. `collaborationRoom.list` takes `section`: `mine` merges the account's own
  owned/invited rows with not-yet-opened invitations matched by verified email; `link` lists rooms
  opened only through general access. The newer `projectionVersion` of the account row and the
  invite row decides whether and where a room is listed. Role copies are display data only.

`pnpm collab:adapters` runs these adapters against a disposable localhost-only PostgreSQL 17
container with multiple connections; it never reads the application database URI. PGlite
`pushSchema` tests separately cover schema/constraints and HTTP binary bounds. Neither establishes
deployed Vercel body limits, UploadThing, DO delivery or end-to-end product acceptance.

## Room adapter delivery

Room alarms deliver metadata jobs through the private adapter endpoint.

- `AdapterClient` uses `COLLAB_ADAPTER_SECRET` and `COLLAB_ADAPTER_URL`. It accepts only the exact
  HTTPS adapter path without URL credentials, query, or fragment, uses manual redirect handling and
  rejects every non-2xx response, propagates the alarm abort signal, and bounds JSON
  command/response bytes at 64 KiB. Response schemas are strict.
- `RoomDelivery` sends projections, storage fences, receipt queries/cancellations, initialization
  verification, and terminal cleanup. A fence acknowledgment must match its sent epoch; a future
  epoch fails closed. Local fence/result commits and version-checked job deletion preserve newer
  coalesced work when an older response returns. Failures retain the durable job/backoff across
  eviction until abandonment.
- Alarms never retransmit snapshot bytes. Content jobs query the immutable receipt and, after the
  original operation deadline, cancel under the same adapter lock. Settling a written asset receipt
  also records its initialization asset identity in the same SQLite transaction while the room is
  initializing.
- Initialization delivery checks local state/assets, verifies the adapter manifest, rechecks local
  state after that response, and obtains the adapter's ready fence acknowledgment before committing
  readiness. Epoch changes cancel obsolete completion work. Terminal cleanup waits for the
  acknowledgment of the terminal storage fence.

## Authenticated management entry

`collaborationAuthority.identity/execute` → private `POST /v1/authority` → `applyAuthorityV1` →
private registration adapter → local Room transaction.

- `authority-identity.ts` reads the current verified user and unexpired session in PostgreSQL under
  the account lifecycle lock. A 60-second protocol-7 proof binds roomId, subject, normalized verified
  email and lifecycle version; it contains no role. The router binds issuance to the logged-in
  session, rate-limits by subject, and rejects disabled or unconfigured service. Frozen accounts,
  unverified email and missing sessions are refused (`FORBIDDEN`); database outages report
  unavailable.
- `COLLAB_IDENTITY_SECRET` signs identity proofs. `COLLAB_AUTHORITY_SECRET` authenticates Vercel to
  Gateway; neither is the adapter capability. Gateway validates the private bearer before parsing a
  bounded 64-KiB body, then validates the proof before obtaining the roomId binding. Room
  independently validates the proof and request deadline. Strict public commands cannot choose
  actors or registration versions. The forwarder forbids redirects, binds responses to the
  requested operation or room, and uses a 15-second deadline.
- Before activation, `authority-registration.ts` locks active account lifecycle rows in sorted subject
  order, then the optional source scene and the roomId lock. It validates proof identity and source
  ownership, then durably registers subjects without requiring a room parent. Room authorizes
  locally before and after external registration and exposes operation receipts only to their
  actor. `remove-email` needs no registration, so withdrawing access works while web is unavailable.
- Creation atomically records the initializing Room and a metadata-only `create-parent` job. Its
  result stays pending until a bound PostgreSQL parent receipt arrives through durable delivery.
  Create replay preserves the original operation identity. Parent creation and terminal fencing
  share the `collaboration_creation_fence` row lock; a terminal fence can acknowledge an absent
  parent only after recording an irreversible ended marker, so a delayed create cannot resurrect it.

## WebSocket authority

The only socket route is `GET /v1/rooms/:roomId/socket`. `collaborationAuthority.identity` returns
a live proof, expiry and `relayUrl` (from the server-only `COLLAB_CONTROL_URL`, http(s) mapped to
ws(s)); the browser presents the proof only in the bounded first `join` control frame's `token`
field, never in a URL or attachment. Gateway checks method, room grammar and allowed Origin
(`COLLAB_ALLOWED_ORIGINS`), strips caller-supplied internal route headers, and forwards to the
roomId binding. Unknown, initializing, ended or denied rooms refuse upgrade.

- Socket attachments are version 4 and retain only verified subject/email/lifecycle identity plus
  bounded session metadata, below the half-platform-cap byte budget. Proofs and payloads are
  excluded.
- Joining verifies the proof and room binding, uses the pre-activation registration adapter, and
  records the opened entry through `RoomAuthority`. Proof expiry bounds the join deadline. After all
  awaited work, the handler rechecks socket/deadline, Room role and live-member capacity before
  publishing attachment and ACK. The ACK carries the Room-derived role.
- Every inbound frame and every fanout receiver rechecks Room authority with the retained identity.
  After a management commit, Room closes affected sockets: `membershipRevoked` when access is lost,
  `roleChanged` (4015, transient; the client reconnects with its new role) when the computed role
  differs, `roomEnded` when the room ends. Peers are broadcast only when enforcement actually closed
  a member. A crash before close is recovered by the next inbound/fanout/alarm check; no frame is
  delivered to a revoked receiver in the meantime.
- Binary fanout, viewer restrictions, byte/rate budgets, backpressure, idle/liveness deadlines,
  hibernation attachments and the cohort epoch high-water are reused. `roomGeneration` on the wire
  is that per-cohort session epoch; it has no cryptographic meaning. There is no periodic idle
  authority poll.

## Binary snapshot entry

The browser uses cookie-authenticated `POST /api/collaboration/snapshot`; web forwards to private
`POST /v1/snapshot` with the authority capability plus a fresh room-bound identity proof in the
8 KiB `x-drawstuff-snapshot-request` header. The body is the plaintext snapshot encoding
(`encodeCollaborationSnapshot`) for put and empty for read/query/cancel/reset. Gateway streams to
the Room through [Request/Response RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response).

- Web requires the application Origin and octet-stream content type, authenticates the session and
  issues the proof; cookies never reach Gateway. Rate limits are listed under
  [shared backend rate limits](#shared-backend-rate-limits); a write first asks Room for the current
  role so outsiders cannot spend the room budget.
- Room verifies identity again, checks its current role and confirmed storage parent, and obtains the
  live lifecycle registration receipt before handling content. Only the owner can write an
  initializing room or reset; ready-room viewers can read, not write.
- At most two read/put transfers run per Room, each bounded at 4 MiB including replays and dishonest
  Content-Length. Room stores only immutable operation metadata plus an alarm-backed result; only a
  confirmed adapter receipt produces `written`. A 15-second timeout cancels stalled readers.
- Replays bind the complete intent and verified actor; query/cancel cannot create an intent or
  inspect another actor's receipt. An unavailable adapter never becomes a successful/cancelled local
  receipt. Reads recheck access and epoch after I/O and before each response chunk; a missing
  snapshot returns its revision watermark so writers never assume revision zero after reset.
- The browser store keeps one pending operation with its original UUID, deadline, epoch,
  expectedRevision, checksum and bytes. Retries query that exact intent before retransmitting the
  same bytes; after expiry they cancel until a terminal receipt. A private canvas fingerprint binds
  recovered receipts to the captured canvas, so a receipt for older edits reports conflict rather
  than saved. Malformed or unavailable loads are `unreadable` and never authorize a new write.

## Room initialization and joining

`createRoomInitialization` retains one roomId and an immutable captured scene (elements and
referenced local files). `create`, snapshot, asset and `complete-initialization` use separate
immutable UUIDs; retries query the original operation and never allocate another room or publish
a link while a result is unknown or pending.

- Create must confirm the parent job before content starts. The browser stores a legal snapshot even
  for an empty canvas, publishes every referenced asset, and completes with the confirmed snapshot
  receipt and every referenced file ID. Inputs are validated before creating a Room.
- The editor captures and pauses the source before the scene lookup yields and keeps editing paused
  while initialization is unresolved. Cancellation sends `cancel-initialization` and releases the
  pause only after confirmed enforcement or an independently ended Room. Sign-out discards the
  local attempt; Room's initialization deadline cleans up stranded metadata/objects.
- `findForScene` checks source ownership and returns an existing initializing/ready room for that
  scene, which is opened directly; the active-scene unique constraint bounds concurrent creation.
- Joining reads Room state (`get-state`, ready only) before preparing the canvas, then obtains an
  identity proof. The invite link is `?collab-room=<id>`; old `#collab-key` fragments are ignored and
  stripped. A Room refusal ends in `failed` with reason `no-access` ("你沒有這個房間的存取權" /
  "回到我的畫布"); the socket ACK decides the live editor/viewer role.

## Management, list and Lifecycle

The share dialog shows the invite link and general access selector (owner can change it); the owner
manages the invitation list (role change, remove, joined hint) and can end the room, others can
leave. Each management call retains one immutable pending operation with a retry entry. The room
list has two sections (see [projections](#storage-and-projection-adapters)); link-section rows have
"從列表移除", which sends `leave` and does not change access.

Lifecycle's private Gateway route (`POST /v1/lifecycle`) validates its service capability and
dispatches a durable subject-scoped operation. Web entry points persist the same intent for retries.
Freeze advances the lifecycle version and revokes sessions; registration shares its lock order.
Enumeration includes preregistered Rooms without DB parents. Room retirement fences local
authorization and sockets, retains retired-subject tombstones and acknowledges only the adapter
storage fence. Lifecycle cascades DB rows and enqueues storage cleanup only after every required
Room acknowledgment.

Admin scene/account retirement, scene deletion, workspace deletion and account purge use that
coordinator. Pending results retain the resource and report pending; completed results allow safe
deletion retries. Better Auth self-delete is disabled because no self-delete product entry exists.
Workspace cascade is allowed only after all source scenes have retired and a locked recheck proves
the workspace empty.

## Components and data flow

```text
browser
  ├─ native elements ─→ @drawstuff/excalidraw-adapter (official reconcile semantics)
  ├─ realtime frames over WSS ⇄ collaboration relay (bounded fanout, per-room Durable Object)
  └─ snapshot/asset requests ⇄ apps/web ⇄ relay Gateway (Room authority)
                                  ├─ shared limit decisions ⇄ Upstash Redis
                                  └─ durable data ⇄ PostgreSQL/UploadThing
```

`@drawstuff/collaboration` owns transport-neutral messages, validation, ordering, join barriers,
offline queues, and recovery policy. `apps/web` binds those contracts to authenticated room APIs and
the editor. The relay imports only server-safe protocol entries; it forwards data frames without
decoding them and does not persist a scene.

Upstash stores expiring rate-limit window state only. It receives canonical user/room identifiers
used as counter keys, but no scene, snapshot, asset bytes or storage capability. PostgreSQL and
object storage remain the only durable collaboration stores.

Scene messages contain native syncable elements. Presence is volatile and independent from scene
delivery. Binary asset bytes never travel inside scene messages.

## Identity and room lifecycle

- `roomId` is created by the browser for `create` and refused by web if it was ever used.
- `peerId` is created by the relay for each connection and is the only collaboration peer identity.
  Reconnect creates a new peer and rebuilds the cursor, matching upstream socket identity behavior.
- There is no client-selected `clientId`. Join frames contain only room, protocol version and the
  identity proof. Anonymous joining is disabled.
- Roles are `owner`, `editor`, and `viewer`, computed by Room as described in
  [Room authority](#room-authority). Viewers cannot publish scene frames.
- Withdrawing access blocks future traffic and closes live sockets, but cannot recall a scene or
  image URL a member already received.

The relay URL comes from the server-only `COLLAB_CONTROL_URL`; clients receive no provider
discriminant and have no fallback path. The fail-closed `COLLAB_ROOMS_DISABLED` switch refuses the
collaboration authority, management, snapshot and asset entry points with `SERVICE_UNAVAILABLE`.

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
- ordering/idempotency uses `(senderPeerId, sequence)` and the current `roomGeneration` (the
  per-cohort session epoch assigned at join);
- reconnect gaps are repaired through full-scene synchronization, durable snapshot, and official
  reconciliation rather than replay state in the relay.

All socket buffers, inbound queues, replay caches, offline queues, timers, and reconnect attempts
have explicit limits. Oversize, capacity, slow-consumer, authorization, rate, idle, and restart
outcomes use distinct close reasons so clients can distinguish terminal from retryable failures;
`roleChanged` (4015) is retryable, `membershipRevoked` and `roomEnded` are terminal.

## Content encoding and confidentiality

Room content is not encrypted by the application. Realtime data frames carry encoded collaboration
messages over WSS; snapshots are `encodeCollaborationSnapshot` bytes with a SHA-256 checksum,
stored as one `collaboration_snapshot.data` row per room; assets are
`encodeCollaborationAssetPayload` bytes (version, metadata, data URL) at public UploadThing URLs.
Relay, Neon and UploadThing operators can read room content, as with owned scenes. Access control,
not ciphertext, is the boundary; see the [threat model](./collaboration-threat-model.md) and
[ADR-0005](../adr/0005-public-collaboration-assets.md). Snapshot and asset payload versions evolve
independently of the transport protocol version.

Identity-proof segments use the shared canonical codec `@drawstuff/collaboration/base64`: one
profile per format (Base64URL always unpadded; zero unused trailing bits; no whitespace), a closed
decode result (`malformed` / `oversize`) instead of host exceptions, and the encoded length bounded
before allocation. Encoding feature-detects the native TypedArray Base64 API and falls back to a
chunked `btoa`/`atob` path; tests hold both to identical output in Node, Chromium, WebKit, and
workerd. Realtime frames stay binary; Base64 never enters the WebSocket hot path. The measured
4 MiB snapshot budget lives in the [SLO document](../performance/collaboration-slo-capacity.md).

Malformed realtime payloads are dropped by the receiver, which converges through `scene-init`
snapshots. Images that fail to download or decode are marked `error` while the scene continues,
and the editor warns once per session.

## Join bootstrap, snapshots, and recovery

Joining subscribes before loading a baseline. Inbound scene messages are held in a bounded join
barrier while an elected peer snapshot and durable snapshot race; the first valid baseline wins,
then buffered messages replay in order and reconcile. The client must never fetch first and
subscribe later.

Only an editor/owner selected deterministically by lowest `peerId` responds to sync and writes
snapshots. Snapshots contain syncable elements only—no presence, viewport, selection, collaborators,
or binary bytes. They are stored as one optimistic-revision row per room. A client that does not
know a valid baseline cannot overwrite it.

Snapshot writers merge the winner after a revision conflict before retrying. Periodic cadence and
forced leave flush share authorization, role, join-epoch, baseline-known, and revision guards. The
flush evaluates those guards and captures the scene _before_ it waits on anything: teardown closes
the transport in the same tick the flush is requested, and the write itself travels over HTTP, so a
guard consulted after an await would veto the one write that persists the room's last edits. A
session that reaches a terminal recovery state clears its own connection state, timers, and
collaborator cursors and refuses further snapshot writes — it never depends on the transport
announcing the disconnect, synchronously or at all.

Room-save state is separate from transport readiness and personal upload status. `snapshot-control`
messages carry sequenced save requests and persistence receipts. Nonwriters request the elected
writer; receipts trigger an independent durable read. Exact element/version/tombstone coverage
and finalized attachment records must match before a member reports saved. Older captures, forged
receipts, or a copy upload cannot clear newer edits. Pending members verify on the bounded cadence
and reconnect reloads confirmation. HTTP persistence calls have deadlines; leave networking remains
best effort. The full destination, timing, and recovery contract is
[collaboration storage](./collaboration-storage.md).

Remote canvas writes run inside the host's dirty-tracking suppression, which is reference-counted:
overlapping windows (element applies resume a frame later; other suppressors may be open in the
same frame) release exactly one hold each, never each other's. Presence-only writes take a separate
synchronous window — at ~30fps per peer, frame-deferred windows would overlap continuously and a
local edit would never mark the scene dirty.

Joining a room claims the tab's canvas independently of cloud scene ownership; a guest never saves
over the owner's scene. The claim is committed in this order:

1. Read Room state (`get-state`). A refused, initializing or ended room stops before changing the
   canvas or issuing a proof.
2. Obtain an identity proof through the bounded rate-limit-aware `identity` call.
3. Resolve local work through save/discard/cancel where needed, preserve the personal draft and
   per-tab identity, cancel debounce, and synchronously hold all personal canvas persistence.
   Only a fresh empty room may use its owner's open source as the initial seed. Reloaded/stored
   rooms reset the canvas and recover from a room baseline rather than the personal cache.
4. Claim the canvas in tab-scoped storage and only then construct the session and open the socket.
   No inbound frame can exist before this point.

A refused join or an exhausted retry budget therefore leaves no collaboration claim. If session construction fails after the claim, that start path releases the claim and every
partially built resource — the transport subscription, the socket, the asset store — immediately.
A bootstrap join failure is classified from the backend's error code, exactly like a reconnect
refusal: only a stated `UNAUTHORIZED`/`FORBIDDEN` verdict reads as an authorization problem, an
ended room reads as the room ending, and everything else (network, 5xx, construction) is
reported as a retryable join failure with a translated message, never the raw error text.
Replacing or clearing the canvas also releases the claim and tears down collaboration-owned
resources. After a completed handoff, teardown restores the preserved personal draft before resuming its
cache writers. Sign-out clears that backup instead of restoring private data.

Recovery classifies disconnects into terminal and retryable outcomes; `roleChanged` is retryable so
a role change reconnects with the new role. A bounded exponential backoff reconnects, obtains a new `peerId`, rebuilds presence, and uses the same
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
| `join`              | authenticated `userId`      | 20/minute      | Authority commands and identity-proof issuance                      |
| `snapshot-request`  | authenticated `userId`      | 120/minute     | Every binary snapshot request, including reads and receipt recovery |
| `snapshot-put`      | canonical `roomId`          | 6/minute       | Room snapshot writes, after a Room role precheck                    |
| `snapshot-finalize` | canonical `(roomId,userId)` | 2/minute       | Leave snapshot after the normal room budget explicitly refuses it   |
| `asset-upload`      | authenticated `userId`      | 60/minute      | UploadThing presign, storage upload and asset commit                |
| `asset-resolve`     | authenticated `userId`      | 120/minute     | Asset authority requests and bounded asset-location batches         |

Identifiers come from authenticated or already-resolved server state, never from a caller-selected
rate-limit key. User-scoped checks run after authentication and input validation. A snapshot write
asks Room for the caller's current role before spending the room budget, and Room authorizes the
binary operation again, so the limiter placement does not weaken revocation.

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
A snapshot write takes the account `snapshot-request` decision and then the room `snapshot-put`
decision; only a leave snapshot whose room budget returns an explicit refusal takes one more against
the finalization reserve. A timeout is
`degraded`, not `limited`, so it proceeds without checking the reserve.

The limiter timeout is 750 ms rather than the SDK's five-second default. Timeout, network error and
SDK exception fail open and emit one structured `collab.ratelimit.degraded` event containing only
the closed `operation` and `cause` enums. They never expose an identifier, endpoint, credential or
raw SDK error. Rate limiting is capacity and abuse protection, not an authorization boundary:
authentication, room role, storage epoch, payload and batch bounds, the 512-assets-per-room cap,
row locks and conditional revisions all continue to fail closed.

No local fallback is installed during an outage. It would look shared while actually producing a
different answer in each serverless instance. There is also no inline retry: retrying an ambiguous
non-idempotent counter operation could spend multiple tokens and would amplify latency during the
incident the timeout is intended to contain.

### Leave snapshot finalization reserve

A snapshot write carries the `x-drawstuff-snapshot-intent` header (`cadence` | `leave`); omitted
intent defaults to `cadence`. Intent is an untrusted scheduling hint, not proof that a tab is
actually closing. Every request first checks the normal six-per-minute room budget. Only an
explicit normal-budget refusal plus `leave` reaches `snapshot-finalize`, keyed by the canonical room
and authenticated user.

The reserve has two tokens per user-room per minute: one for the captured final scene and one for
the existing single conflict-merge retry. Calling every write `leave` therefore buys only two
bounded extra attempts, never a bypass. All ordinary role, epoch, baseline-known and
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

## Room assets

Elements travel through realtime; image bytes use UploadThing and the web API. Asset identity is
`(roomId, excalidraw_file_id)`. The backend stores the provider key, current URL, byte length and
uploader; MIME type and data URL live inside the plaintext asset payload. Room assets are public
objects with the same exposure as owned-scene images
([ADR-0005](../adr/0005-public-collaboration-assets.md)).

- Web forwards asset requests to private `POST /v1/assets` with the authority capability and a fresh
  identity proof. Room authorizes owner-only initialization and current ready-room access before and
  after live registration. Viewer reads are allowed; viewer presign/finalization and non-owner
  initialization access are refused. Reads recheck role, epoch, proof and deadline before exposing
  provider URLs.
- Presign checks the immutable actorless intent against the current epoch and deadline without
  staging bytes. Only the verified UploadThing callback binds the actual provider key/URL/length;
  it reissues the proof from the live original account/session. Room then accepts `asset-finalize`,
  writes through the adapter's locks/fences, and commits the receipt with its initialization asset
  manifest. Alarms recover or cancel unknown accepted operations; no alarm retries uploads.
- The browser retains bounded metadata for at most 512 unknown intents and permits one provider
  upload per intent. Only a terminal cancellation or Room-certified expired absence permits a new
  upload; browser time alone never establishes absence. The intent checksum binds metadata to the
  uploaded payload; the server does not download provider objects to verify it.
- Unknown/refused callbacks enqueue cleanup under the same provider-object advisory lock as
  finalization. A referenced object is never queued, and queued garbage cannot later become a live
  reference. Cleanup driver failures are sanitized before the provider SDK can log object keys.

Resolve requests are bounded batches. Client upload/download concurrency, retry chains, remembered
IDs, response bodies, and in-flight tasks are bounded and abortable. A storage URL is not durable
identity. Missing assets retry; images that fail to download or decode are marked unavailable
without blocking element convergence.

Room-end cleanup deletes the room's asset rows and enqueues their object keys in
`deferred_file_cleanup`; maintenance retention is the backstop. Full room and owned-scene retention
behavior is defined in [data lifecycle](./data-lifecycle.md).

## Current operational boundaries

- Realtime fanout is isolated per `roomId` in a `CollaborationRoomV2` Durable Object; the thin
  Worker gateway checks Origin and service capabilities, validates identity proofs and derives
  Object identity.
- Durable Object connection/frame limits and the shared backend limits described above are implemented.
  WAF or edge rate limiting remains a possible additional layer, not part of the current contract.
  See [SLO §5](../performance/collaboration-slo-capacity.md), the
  [threat model](./collaboration-threat-model.md), and the
  [observability contract](../observability/collaboration-do-observability.md).
- Workers Logs and privacy-safe structured logs exist. Client/session success and
  snapshot-conflict SLOs currently have no telemetry carrier.
- There is no Node fallback or percentage rollout; the global `COLLAB_ROOMS_DISABLED` kill switch
  is the incident boundary. There is still no staging environment, formal
  capacity load test, or complete incident runbook. These are accepted operating limits for the
  current personally operated, limited-public-test service.
