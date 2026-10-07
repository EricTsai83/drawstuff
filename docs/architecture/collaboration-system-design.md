# Collaboration system design

- Status: Current
- Generalized patterns: [realtime room coordination](../system-design/realtime-room-coordination.md),
  [E2EE key lifecycle](../system-design/e2ee-key-lifecycle.md),
  [transactional outbox](../system-design/transactional-outbox.md),
  [defensive boundaries](../system-design/defensive-boundaries.md)
- Security model: [collaboration threat model](./collaboration-threat-model.md)
- Capacity contract: [collaboration SLO](../performance/collaboration-slo-capacity.md)
- Deployment contract: [Durable Object deployment runbook](../operations/collaboration-do-deployment.md)

## 18B P1 source artifact and P2 boundary

The repository contains the protocol-v6 data foundation. Production has not been reset or
deployed to it: the production description below still refers to protocol v5 and DB authority.
The P1 artifact is **not independently deployable**. P2 must connect all authenticated entry
points and storage adapters, and P3 must perform the controlled reset before it is deployed.

- `packages/collaboration/authority` defines strict identity-only proofs, immutable content
  operations, query/cancel/fence commands, initialization manifests, monotonic projection events,
  stable list cursors, management outcomes, and subject-scoped retirement commands. Proofs grant
  identity, not a caller-selected role. HMAC signing stays in the server-only `room-token` module.
- `RoomAuthority` owns SQLite room state (`initializing`, `ready`, `ended`), owner, members,
  normalized allowlist addresses, permanent revocation/retirement decisions, crypto generation,
  authorization revision, storage epoch, immutable operation metadata, and initialization progress.
  `roomChannelKey` now resolves to roomId across generations; generation changes cannot create a
  fresh authority store. The remaining generation URL segment is transport metadata, not DO identity.
- Initialization completion stays pending until the adapter confirms the declared latest snapshot
  and complete finalized asset manifest. A terminal local transition cancels completion work,
  rejects late finalization, and durably retains fence and orphan-cleanup work. An empty ready
  room has no TTL or heartbeat; its cohort high-water and terminal decisions remain durable.
- `DurableWork` commits business state, operation results, jobs, and the alarm in one local storage
  transaction. External delivery runs outside that transaction, with a 16-job/5-second alarm budget,
  a cancellation signal, bounded persistent backoff, and version-checked acknowledgments. Only
  terminal results expire after 24 hours; unfinished work does not disappear. No job stores a
  snapshot, image bytes, plaintext, or root key.
- Ordinary work is capped at 128 jobs and safety reserve at 64. Exhausted reserve durably denies
  the whole room, retaining one emergency room fence and at most one emergency orphan-cleanup
  job. Safety mutations that outrun ordinary projections retain a dirty cursor and rebuild
  projections in bounded batches. Allowlist storage, including removed-address decisions, is
  capped at 200 entries. Initialization allows the existing 512-asset generation limit;
  individual metadata jobs are capped at 64 KiB. Management/content result stores each cap at
  4,096 entries and refuse new work until capacity is available.
- `CollaborationLifecycle` has a SQLite-backed binding per account/scene. `LifecycleProgress`
  persists freeze, cursor enumeration, per-room enforcement, deletion, and completion. It
  retains the terminal subject decision and compares a local progress revision after every
  external response so late results cannot move retirement backwards. Adapter calls must
  deduplicate by the original operationId and lifecycle version.
- PostgreSQL now permits room rows without scenes, removes room expiry, and carries initialization,
  epoch, and projection metadata. The partial unique scene index includes initializing/ready
  rooms and permits multiple NULL scene ids. An optional scene FK retains cascade semantics
  for source-linked rooms; P2 must confirm their retirement before any cascade. Independent
  rooms have no such relation. Pre-activation lifecycle registration deliberately has no room
  FK, so a still-creating room cannot be omitted. Lifecycle and projection tombstones have no
  parent FK and outlive parent deletion. List projection indices use `(userId, listedAt, roomId)`;
  scene joins are not required. Snapshot bytes still live only in the existing snapshot table.

P1 leaves the legacy DB-role issuer, control outbox/drainer/cron, and ordinary content/retirement
entry points for the P2 replacement. The P1 alarms retained unconfigured delivery jobs for retry;
the P2 Room delivery unit below now supplies its authenticated client. Lifecycle delivery remains
unconfigured. The P2 units below verify login proofs and pre-activation registration, provide storage/
projection adapters, and deliver initialization/fence acknowledgments. P2 must still connect binary
product and realtime entry points, retirement from every deletion entry, and remove the old paths. P1 runtime/PGlite tests establish
local persistence and schema semantics; they do not establish cross-cloud or production behavior.

## 18B P2 storage and projection adapters

The source now contains the storage/projection adapter backend; it has not been deployed or wired
into browser/UploadThing/retirement product entry points. Authenticated management and parent creation
are described below. The existing DB-role writers and control outbox remain until the remaining P2 units. Room delivery is described below; Lifecycle
delivery remains unconfigured. This intermediate artifact cannot be deployed on its own.

`POST /api/internal/collaboration/adapter` accepts only the private `COLLAB_ADAPTER_SECRET` bearer
capability. It is separate from join/login and cron credentials; unset configuration refuses all
requests before body parsing. Browser sessions, identity proofs and caller-supplied roles do not
authenticate this endpoint. Provision matching service credentials only when the authenticated
Room delivery path is complete. Content storage helpers require an already-persisted room parent;
the authenticated management unit below supplies creation and pre-activation registration.

- `authority-storage.ts` locks the room row for writes, cancellation, result query, reads,
  initialization checks, cleanup and fence advancement. Snapshot effects and immutable operation
  receipts commit together. The fingerprint includes the entire parsed intent, including actor,
  deadline and asset descriptor. Replays return the original outcome/revision; changed intent is
  rejected, including concurrent UUID reuse across rooms. Missing receipts are pending, not proof
  of cancellation. Expired original writes and old epochs/generations cannot write after receipt
  pruning. Terminal receipts are pruned in bounded batches after 24 hours; pending rows remain.
- `storageGeneration`, `storageState` and `authorityEpoch` are adapter fence state, independent
  from display projections. A fence waits for earlier room-locked writes to commit. Terminal
  storage state cannot reopen. Generation rotation requires a new epoch and an initialization
  deadline, resets the snapshot revision for that generation, and retires older ciphertext through
  the existing deferred object cleanup queue. Snapshot reset retains a revision high-water so
  revision zero does not become valid again. A reset receipt's revision identifies the deletion;
  an asset-finalize receipt uses revision 1 for the immutable generation/file identity.
- Initialization verification checks the latest declared snapshot and all declared finalized
  assets under the same lock. It does not make the Room ready. A subsequent snapshot write
  invalidates that verification; promoting adapter state to ready requires a current confirmation.
  Room delivery checks local key-check and completion state, and does not report Room readiness
  before the required parent and ready-fence acknowledgments.
- Snapshot writes use an octet-stream body plus a strict command header capped at 8 KiB. Other
  commands use bounded JSON bodies (64 KiB), including initialization manifests. Actual streamed
  snapshot bytes are bounded at the existing ciphertext ceiling, independently of Content-Length,
  and their envelope version/checksum are checked before a DB lock is taken. Snapshot reads return
  binary bytes plus revision/checksum metadata and `no-store`. No Base64 or DO payload staging is
  introduced. The future DO caller must enforce its two-body quota and recheck local access after
  reads return; this endpoint alone does not establish those cross-hop guarantees.
- Finalization trusts only provider metadata supplied by the authenticated upload delivery path.
  It preserves the existing file-id identity, bounds assets per generation, and queues rejected or
  duplicate unreferenced provider keys for cleanup in the same transaction. Provider-key advisory
  locks serialize new references and orphan-cleanup decisions across rooms. Existing references
  are never queued as orphans, and keys already queued for deletion cannot become new references.
  Direct UploadThing bytes/ACLs and verified upload callbacks remain part of the next entry unit.
- `authority-projection.ts` conditionally applies per-subject versions and persistent negative
  tombstones, without changing the storage fence. It handles re-grants only above the tombstone,
  ignores obsolete events, rejects parent-deleted/frozen accounts, and cannot reopen ended rooms.
  Negative events still apply while an account is frozen. The server-only list helper uses stable
  descending `(listedAt, roomId)` pagination, excludes negative/frozen projections, and includes
  NULL-source rooms without a scene join. Role copies are display data, never an authorization source.

Run `pnpm collab:adapters` for actual PostgreSQL races. The wrapper creates one random disposable
PostgreSQL 17 container on a localhost-only random port and removes it afterwards; it never reads
the application database URI. Tests apply DDL generated from the current source schema and invoke
the actual adapter implementations with multiple connections. PGlite `pushSchema` tests separately
cover schema/constraints and HTTP binary bounds. These are local SQL and handler tests, not a
deployed Vercel body-limit, UploadThing, DO delivery or end-to-end product acceptance.

## 18B P2 Room adapter delivery

Room alarms now deliver metadata jobs through the private adapter endpoint. This is a source-only
unit: browser content forwarding, verified upload callbacks, Lifecycle adapters, and deletion entry
points are still pending. The following unit supplies login/Gateway management and parent registration.
The artifact remains unsuitable for independent deployment; no production credentials were provisioned.

- `AdapterClient` uses the dedicated `COLLAB_ADAPTER_SECRET` and operator-configured
  `COLLAB_ADAPTER_URL`. It accepts only the exact HTTPS adapter path without URL credentials,
  query, or fragment, forbids redirects, propagates the alarm abort signal, and bounds actual JSON
  command/response bytes at 64 KiB. Response schemas are strict. It cannot forward snapshot bodies
  or read ciphertext; those entry points still need the two-body quota and local access recheck.
- `RoomDelivery` sends projections, storage fences, receipt queries/cancellations, initialization
  verification, and terminal cleanup. A successful obsolete/negative projection acknowledgment
  completes that job. A fence acknowledgment must match its sent epoch; a future epoch fails closed.
  Local fence/result commits and version-checked job deletion preserve newer coalesced work when
  an older response returns. Failures retain the durable job/backoff across eviction.
- Missing snapshot bytes are never retransmitted by alarms. Content jobs query the immutable
  receipt and, after the original operation deadline, cancel under the same adapter lock. A prior
  written result keeps its original revision. Settling a written asset receipt also records its local
  initialization asset identity in the same SQLite transaction, if that generation is still initializing.
- Initialization delivery checks current local state/assets, verifies the adapter manifest, rechecks
  local state after that response, and obtains the adapter's ready fence acknowledgment before
  committing local readiness. Lost responses repeat the verification/fence sequence. Safety epoch
  changes cancel obsolete completion work; successful readiness cancels competing completion
  requests. A late response cannot override local cancellation, rotation, or initialization expiry.
  Terminal cleanup waits for the local acknowledgment of the terminal storage fence.
- Tests run in workerd with bounded fake HTTP responses, actual SQLite transactions, eviction, and
  the actual alarm's configured delivery and unconfigured failure paths. They cover recovery, coalesced fence responses,
  aborts, response bounds, receipt query/cancel, ready acknowledgment, local cancellation, asset
  manifest persistence, and competing completion requests. They do not establish deployed cross-cloud
  latency or complete authenticated product flows. Alarm delivery retains the existing 16-job/5-second
  budget and persistent retry schedule; it does not add a periodic idle-room tick.

## 18B P2 authenticated management entry

The server management path now connects a live login to Room authority:
`collaborationAuthority.identity/execute` → private `POST /v1/authority` → `applyAuthorityV1` →
private registration adapter → local Room transaction. This remains a source artifact awaiting the
remaining P2 entry points and the P3 reset. No service credentials or production schema were changed.

- `authority-identity.ts` reads the current verified user and unexpired session in PostgreSQL under
  the account lifecycle lock. A 60-second protocol-v6 proof binds roomId, subject, normalized verified
  email and lifecycle version; it contains no room role. The router binds issuance to the logged-in
  session, rate-limits by subject, and rejects disabled or unconfigured service. Frozen accounts and
  missing sessions refuse authorization; database outages report unavailable.
- `COLLAB_IDENTITY_SECRET` signs identity proofs. A separate `COLLAB_AUTHORITY_SECRET` authenticates
  Vercel to Gateway; neither is the legacy join secret or the adapter capability. Gateway validates
  the private bearer before parsing a bounded 64-KiB body, then validates the proof before obtaining
  a Room binding. Room independently validates the proof and request deadline. Strict public commands
  cannot choose actors or registration versions. The forwarder forbids redirects and binds responses
  to the requested operation or room, with a 15-second deadline; a failed response is never success.
- Before activation, `authority-registration.ts` locks active account lifecycle rows in sorted subject
  order, including the room owner and any explicit grant target, followed by the optional source scene.
  It validates current proof identity and source ownership, then durably registers subjects without
  requiring a room parent. Freeze must use the same lock order. Registration rows survive parent cascade;
  conservative extra rows are safe. Room authorizes locally before and after external registration,
  obtains grant-target versions from the adapter, and exposes operation receipts only to their actor.
- Creation atomically records the initializing Room and a metadata-only `create-parent` job. Its result
  remains pending until a bound PostgreSQL parent receipt arrives through durable delivery. Readiness
  additionally requires the existing complete snapshot/asset manifest and ready fence acknowledgment.
  Create replay preserves the original operation identity; it does not allocate another room parent.
  The parent acknowledgment is retained in Room state independently of the 24-hour receipt cleanup,
  so later generation rotation can initialize after the original create result has been pruned.
- Parent creation and terminal fencing share a persistent `collaboration_creation_fence` row lock.
  A terminal fence can acknowledge an absent parent only after recording an irreversible ended marker.
  The marker has no parent FK: cancellation before parent delivery and parent deletion both prevent a
  delayed create from resurrecting the parent. Content writes still require a present, unfenced parent.
- Any Room with formal authority state refuses legacy WebSocket and control ingress and disconnects
  existing legacy sockets. Formal realtime and browser initialization/content/upload flows must be
  connected next; this unit does not expose a working product realtime channel or provide a mixed-mode
  deployment. Owner management/state queries can inspect initializing or ended state; ordinary join
  requires ready state and Room-derived access. Restricted mode uses the allowlist; open-link mode
  uses linkRole, with persistent member revocation taking precedence in both modes.

workerd tests cover verified Gateway → Room RPC forwarding, private Gateway refusal, proof boundaries, registration failure/late retirement,
eviction and parent-job recovery, strict target versions, own-actor queries and legacy ingress isolation.
Web tests cover the live session/account contract, pre-parent registration, parent replay/cancellation,
forwarding bounds and tRPC identity binding. `pnpm collab:adapters` now runs eight actual PostgreSQL
tests, including account freeze versus registration and terminal fence versus missing-parent creation.
These local tests do not establish deployed cross-cloud behavior or complete product flows. Lifecycle
delivery, every deletion entry, formal WebSocket/binary/upload entry points, legacy path removal, and
reset/rollback rehearsal remain P2 work before P3 deployment.

The production description below describes the existing deployment. The relay is a Cloudflare
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
flush evaluates those guards and captures the scene _before_ it waits on anything: teardown closes
the transport in the same tick the flush is requested, and the write itself travels over tRPC, so a
guard consulted after an await would veto the one write that persists the room's last edits. A
session that reaches a terminal recovery state clears its own connection state, timers, and
collaborator cursors and refuses further snapshot writes — it never depends on the transport
announcing the disconnect, synchronously or at all.

Room-save state is separate from transport readiness and personal upload status. Protocol v5 uses
encrypted, sequenced save requests and persistence receipts. Nonwriters request the elected writer;
receipts trigger an independent decrypted durable read. Exact element/version/tombstone coverage
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

1. Fetch room metadata and verify the fragment-held key against the generation's key check. A bad
   or incomplete link stops before changing the canvas or minting a token.
2. Mint the join token through the bounded rate-limit-aware join call and verify that its generation
   is still the one whose key check passed. Read the snapshot locator before the handoff.
3. Resolve local work through save/discard/cancel where needed, preserve the personal draft and
   per-tab identity, cancel debounce, and synchronously hold all personal canvas persistence.
   Only a fresh empty room may use its owner's open source as the initial seed. Reloaded/stored
   rooms reset the canvas and recover from a room baseline rather than the personal cache.
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
resources. After a completed handoff, teardown restores the preserved personal draft before resuming its
cache writers. Sign-out clears that backup instead of restoring private data.

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
