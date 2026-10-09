# Collaboration system design

- Status: Current
- Generalized patterns: [realtime room coordination](../system-design/realtime-room-coordination.md),
  [browser-side encryption and key lifecycle](../system-design/e2ee-key-lifecycle.md) (rooms
  are no longer end-to-end encrypted since plan 19),
  [transactional outbox](../system-design/transactional-outbox.md),
  [defensive boundaries](../system-design/defensive-boundaries.md)
- Security model: [collaboration threat model](./collaboration-threat-model.md)
- Capacity contract: [collaboration SLO](../performance/collaboration-slo-capacity.md)
- Deployment contract: [Durable Object deployment runbook](../operations/collaboration-do-deployment.md)

## 18B P1 source artifact and P2 boundary

Protocol 6, Room SQLite authority, storage/projection adapters and Lifecycle retirement are
now deployed. Current invariants and the 18C handoff are defined in the
[authority contract](collaboration-authority.md). The following P1/P2 boundary sections preserve
implementation-stage context; references to undeployed P2 or protocol-v5 production describe
the earlier stage, not today's production. Acceptance evidence is in the deployment runbook;
remaining issues are tracked in [18D](../../plans/18d-collaboration-acceptance-follow-ups.md).

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
product entry points, retirement from every deletion entry, and remove the old paths. Formal realtime
authority is described below. P1 runtime/PGlite tests establish
local persistence and schema semantics; they do not establish cross-cloud or production behavior.

## 18B P2 storage and projection adapters

The source contains the undeployed storage/projection adapter backend. Browser snapshot and
product initialization and attachment wiring are described below; remaining management and retirement remain pending. Authenticated management and parent creation
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
  introduced. The binary Room entry below enforces the two-body quota and local access recheck;
  this private adapter endpoint alone does not establish those cross-hop guarantees.
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
  command/response bytes at 64 KiB. Response schemas are strict. Alarm calls remain metadata-only; dedicated binary methods
  serve the snapshot entry below, which owns its two-body quota and local access recheck.
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
  existing legacy sockets. The next unit below supplies formal realtime authority; browser
  initialization/content/upload flows still need connection. This does not provide a mixed-mode
  deployment. Owner management/state queries can inspect initializing or ended state; ordinary join
  requires ready state and Room-derived access. Restricted mode uses the allowlist; open-link mode
  uses linkRole, with persistent member revocation taking precedence in both modes.

workerd tests cover verified Gateway → Room RPC forwarding, private Gateway refusal, proof boundaries, registration failure/late retirement,
eviction and parent-job recovery, strict target versions, own-actor queries and legacy ingress isolation.
Web tests cover the live session/account contract, pre-parent registration, parent replay/cancellation,
forwarding bounds and tRPC identity binding. `pnpm collab:adapters` now runs nine actual PostgreSQL
tests, including account freeze versus registration, terminal fence versus missing-parent creation, and reset versus a missing-snapshot revision read.
These local tests do not establish deployed cross-cloud behavior or complete product flows. Lifecycle
delivery, every deletion entry, binary/upload product entry points, legacy path removal, and
reset/rollback rehearsal remain P2 work before P3 deployment.

## 18B P2 formal WebSocket authority

The source now exposes `GET /v1/rooms/:roomId/socket` for formal rooms. Its generation-free URL
keeps one Room authority across crypto rotation. The authenticated `collaborationAuthority.identity`
procedure returns a live verified proof, expiry and relayUrl; the browser presents that proof only in
the existing bounded first `join` control frame's `token` field, never a URL or attachment. Gateway
checks method, canonical room grammar and allowed Origin, strips caller-supplied internal route
headers, and forwards to the roomId binding. Unknown, initializing, ended or denied rooms refuse upgrade.

- Formal pending/joined socket attachments use version 3; joined attachments retain only verified
  subject/email/lifecycle identity plus bounded session metadata. The verified subject is the
  root attachment subject; it is stored once, with email and lifecycleVersion. Maximal variants,
  including a Unicode subject, remain below the existing half-platform-cap byte budget.
  Proofs, room keys and payloads are excluded. Legacy version-2 attachments grant no formal access.
- Joining verifies the identity proof and room binding, uses the private pre-activation registration
  adapter, and commits membership through `RoomAuthority`. Proof expiry bounds the join operation's
  deadline, so an expired proof cannot create membership after delayed registration. After all awaited
  work, the handler rechecks socket/deadline, Room role, current generation and live-member capacity
  before publishing attachment and ACK without another await. Registration failure, mismatched receipts,
  late retirement and stale generations fail closed. The proof grants identity; Room supplies the role.
- Every formal inbound frame and every fanout receiver rechecks durable Room authority using its
  retained identity. Role copies in attachments and PostgreSQL projections do not authorize traffic.
  Role changes close affected sessions so reconnect obtains the correct role. Owner management RPCs
  close affected joined/pending sockets after local commit; unaffected members remain connected.
  The alarm rechecks access before external delivery. A crash before close is recovered by the next
  inbound/fanout/alarm check; ciphertext is never delivered to a revoked receiver in the meantime.
- Existing opaque binary fanout, viewer restrictions, byte/rate budgets, backpressure, idle/liveness
  deadlines, hibernation attachments and cohort epoch high-water are reused. There is no periodic idle
  authority poll. Rotation closes the old cohort and refuses new joins until initialization completes;
  Room identity and membership tombstones persist. Ended state refuses future upgrades and traffic.
  Legacy generation routes/control tokens remain source-only pending product conversion and removal;
  they cannot enter a formal authority room or select the formal route using spoofed internal headers.

workerd tests exercise actual Gateway/WebSocket and management RPCs with bounded fake adapter HTTP:
registered join, eviction/fanout recovery, legacy/expired/wrong-room proofs, Origin/internal-header
boundaries, prompt revocation, recovery after a missed close, viewer restrictions, late retirement,
proof expiry during registration, adapter failures and generation/end transitions. Attachment tests pin
all retained fields and maximal sizes; the web router test pins the returned generation-free URL.
Ready state is seeded only in these realtime tests: they do not claim a completed product initialization,
binary persistence, verified upload callback, Lifecycle retirement, or deployed cross-cloud acceptance.
The units below connect binary storage, snapshot cadence/reset, attachment-free product initialization
and identity-proof session routes. Asset-bearing initialization, management UI, every retirement/deletion
entry, legacy path removal and reset/rollback rehearsal remain gates before P3 deployment.

## 18B P2 binary snapshot backend entry

The source adds private `POST /v1/snapshot`, authenticated with the existing management service
capability plus a live room-bound identity proof. An 8 KiB `x-drawstuff-snapshot-request` header
contains a strict read request or immutable snapshot-put/reset intent; actor fields are refused.
The body is binary ciphertext for put and empty for read/query/cancel/reset. Gateway verifies the
service capability and proof before selecting the roomId binding, bounds actual forwarded bytes,
and uses streaming [Request/Response RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response) to the same Room. The authenticated web proxy is described below;
product snapshot-client conversion is described below.

- Room verifies identity again, checks its current role and confirmed storage parent, and obtains
  the private live actor/owner/scene lifecycle registration receipt before handling content. Only
  the owner can use initializing-room content before its deadline, or reset; ready-room viewers can read, not write.
  PostgreSQL projections and browser actor claims never grant access. External I/O stays outside
  local transactions and does not block other Room events.
- At most two read/put transfers run per Room. Each body is bounded by the 4 MiB plaintext budget
  plus the existing sealed-envelope overhead, including replays and dishonest Content-Length.
  Room buffers a bounded body in memory, validates envelope/checksum, and stores only immutable
  operation metadata plus an alarm-backed result. Adapter writes remain conditional PostgreSQL
  transactions; only a confirmed receipt produces written. Control/query/cancel requests do not
  consume a body slot. A 15-second timeout cancels stalled readers and releases reservations.
- Replays bind the complete intent and verified actor. Query/cancel cannot create a new intent or
  inspect another actor's receipt, and can recover retained receipts after the original deadline.
  Lost write replies leave pending work; query/alarm can recover the original revision after eviction
  or durably cancel a missing body. An unavailable adapter never becomes a successful/cancelled
  local receipt. Alarms never recreate or persist ciphertext.
- Reads bind adapter room/generation/epoch/revision metadata, actual length, envelope and checksum.
  Room rechecks current access and generation/epoch after I/O, including missing-snapshot replies,
  and before each bounded response chunk. A missing snapshot returns its locked revision watermark
  in the receipt header, so reset cannot cause subsequent writers to assume revision zero.
  The read slot remains reserved through stream consumption
  or cancellation. Previously delivered/enqueued bytes cannot be recalled after revocation; later
  Room chunks fail closed. Revocation while receiving a write body prevents its adapter dispatch.

Fifteen new workerd tests cover maximum legal Gateway/RPC/adapter round trips, oversized and corrupt
bodies/receipts, identity/service boundaries, immutable replay/cancel, lost-reply eviction recovery,
initial owner/manifest completion, two-body saturation, response cancellation and revocation races.
Actual WebSocket fanout and management remain live while a snapshot adapter read is stalled.
These runtime tests use fake private adapter HTTP responses; the existing real PostgreSQL adapter
suite separately verifies storage/fence ordering. Deployed Vercel body limits, cross-cloud load and
complete product flows remain acceptance gates. Attachment, remaining management and Lifecycle/deletion
conversion remain P2 work; product snapshot and attachment-free initialization wiring are described below.

## 18B P2 authenticated web binary snapshot entry

The source adds cookie-authenticated `POST /api/collaboration/snapshot` and a browser binary
transport client. The product conversion below connects snapshot cadence/reset and removes the old
tRPC snapshot endpoints. The source is **not independently deployable** until all P2 entries are
converted and P3 resets storage and deploys matching builds.

- Every request requires the configured application Origin and octet-stream content type. Strict
  metadata is capped at 8 KiB and refuses actor/proof fields. The server authenticates the session,
  then issues a room-bound proof from the live verified account/session and lifecycle state. Only
  that proof and the private server capability reach Gateway; browser cookies and authorization
  headers never do. Missing credentials, disabled rooms and non-HTTPS Gateway URLs fail closed.
- A new `snapshot-request` budget allows 120 requests/minute per authenticated account, including
  reads and receipt recovery, before live proof issuance. Writes additionally obtain a Room role
  precheck before spending the existing shared 6/minute snapshot-put budget. Only explicitly limited
  put requests marked leave may use the existing 2/minute `(room,user)` reserve. Room authorizes
  again on the binary operation, including owner-only reset and initializing-room access. Redis
  degradation does not bypass those checks. Query/cancel do not spend room write budgets.
- Uploads are bounded by actual ciphertext bytes before forwarding, with checksum/envelope checks;
  read/query/cancel/reset bodies must be empty. No room key or plaintext is accepted. Downloads stay
  streamed so web does not prefetch the whole Room reply and delay its chunk-time authorization.
  Receipt metadata binds room and legal byte length; stream truncation/overflow, abort and the
  15-second overall deadline cancel the upstream reader. Only whitelisted response headers and
  strict outcomes are forwarded; malformed or oversized upstream JSON returns unavailable.
- The browser transport verifies length/envelope/checksum before returning encrypted read bytes,
  preserves an absence revision watermark, and leaves pending as pending. It accepts the caller's
  original operationId/intent and ciphertext for write/query/cancel and never invents retry IDs or
  re-encrypts. A written receipt must have expectedRevision + 1. The product store below retains
  pending ciphertext and binds recovered receipts to the saved canvas before displaying saved.
- Fifteen web/client tests exercise ingress refusal, live identity plumbing, room budget ordering,
  late Room refusal, reset watermarks, metadata/body bounds, upstream error sanitization, cancellation,
  exact immutable requests, and a maximum 4 MiB valid snapshot JSON sealed in the browser, transported
  through the real web handler with fake Gateway replies, then opened and decoded. These do not
  establish deployed Vercel body admission or cross-cloud load; both remain P3 acceptance gates.

No production DB migration, schema push, reset or deployment was performed for this unit. Schema
changes remain source artifacts. After all P2 entries are converted and reset/rollback rehearsals
pass, P3 must review/apply the collaboration-only schema diff and reset collaboration test data,
preserving accounts, personal/shared/published scenes and their attachments. See
[deployment and acceptance evidence](../deployment/collaboration-reset/README.md).
The product unit below completes snapshot load/save/reset conversion and old tRPC removal.

## 18B P2 product binary snapshots

Product bootstrap, durable load/save cadence, and the owner's two-click reset now use the binary
client. `collaborationSnapshot.get/put/reset` and their legacy storage helpers are removed from
source. The tRPC transport refuses all three old procedures even for a signed-in caller. Remaining
room management, attachment-bearing initialization/finalization and deletion/retirement paths still require
P2 conversion; this is not a deployable cutover by itself.

- Bootstrap checks the receipt's generation against the joined generation before claiming the
  canvas. Only revision-zero absence can seed a fresh room from its owner's source scene. The
  store opens/validates ciphertext before adopting an authority epoch; an empty receipt must also
  match the session generation. An unreadable/unavailable load cannot authorize a new store write.
- One in-memory pending operation retains its original UUID, deadline, generation, epoch,
  expectedRevision, checksum and sealed bytes. Retries query that exact intent before retransmitting
  the same ciphertext. After expiry they cancel until a terminal receipt; unavailable query/cancel
  leaves the original intent intact. A never-accepted intent queried absent after its deadline cannot
  arrive as a new write, so it is discarded without late body replay. No new UUID is minted until
  the old intent settles. Alarms retain metadata only, and browser exit can still lose unconfirmed bytes.
- A private plaintext/context fingerprint binds recovered receipts to the caller's captured canvas.
  A receipt for older edits returns conflict rather than written for newer edits. Cadence reloads
  and merges the durable winner before saving a new capture. New attempts invalidate old coverage
  confirmation, so reverting the canvas while a different operation is pending cannot revive an
  obsolete saved indicator. Only confirmed matching coverage restores saved.
- Empty baselines retain the reset watermark, clear the prior digest/coverage and supply the next
  expectedRevision. A leave conflict with an empty winner retains captured final edits and retries
  once using that watermark. Query/cancel remain available for pending work even when the caller's
  current capture changed, and an unchanged digest cannot skip an outstanding operation.
- Owner reset uses a read receipt and an empty-body snapshot-reset intent. Button retries retain
  the same operation. Pending, refusal and transport failure do not emit the success toast or retry
  join; only written does. No room key/plaintext is sent for reset.
- Nineteen new product/store/surface/session/UI tests cover the old endpoint refusal, generation
  mismatch, immutable lost-reply recovery, byte-identical retransmission, expiry and unavailable
  cancellation, concurrent saves, actual binary-client encryption/load, reset receipt recovery,
  initial/reset/leave watermarks, saved coverage after edits/reverts, and reset-button confirmation.
  Obsolete router tests are replaced by these plus the existing binary ingress/Room/storage suites;
  join and attachment limiter regression tests remain.

This unit changes no DB schema and performs no production migration/reset/deployment. Tests use
fake binary storage effects and local PGlite for remaining router regressions. Product creation/join
and attachment-free initialization are described below. Attachment and Lifecycle/deletion
conversion and deployed body-limit/cross-cloud acceptance remain pending before P3.

## 18B P2 product authority initialization

The undeployed product now creates attachment-free rooms through `collaborationAuthority.execute`,
loads key-check metadata from live Room state and connects/reconnects with `collaborationAuthority.identity`.
The proof is identity-only and the generation-free socket grants the latest Room role. No product
bootstrap or creation call uses the old DB `create/join` procedures. Remaining legacy room management,
key rotation, DB panel/projection reads, upload and retirement entry points still need conversion/removal;
this artifact cannot be deployed independently or pushed to the automatic deployment branch.

- A browser initialization attempt retains one roomId, root key and immutable captured scene. Create,
  key-check, snapshot and completion have separate immutable UUIDs. The key-check intent pins its
  expected generation; Room rejects a late old-generation verifier after rotation. Management retries
  query the
  original operation with a fresh query deadline; only an explicitly absent, unexpired intent is
  replayed. Unknown results and pending receipts never allocate another room or publish a link.
  Snapshot retries retain the original sealed bytes through the binary store. No key or plaintext
  travels in generic authority commands (plan 19 key custody uses the separate `/v1/room-key`
  path); the manifest carries only generation, revision, ciphertext checksum
  and declared asset IDs.
- Create must confirm the parent job before content starts. The browser seals the generation-one
  key-check, explicitly stores a legal encrypted snapshot even for an empty canvas, and completes
  only with its confirmed snapshot receipt. It waits for the completion receipt and rechecks live
  ready/generation/key-check before exposing the fragment key. Right after `set-key-check` the
  creator escrows the key to Room custody (best effort; creation does not fail if it fails). Lagging display projection does not
  block readiness. Inputs are validated before creating a Room.
- The editor captures and pauses the source before the scene lookup yields, so a newly loaded
  canvas cannot seed an unrelated source room. It keeps editing paused while initialization is
  unresolved, and button retries retain the same attempt. Cancellation uses an immutable owner end intent and releases the pause only
  after confirmed enforcement or an independently ended Room. Its own pending end intent must still
  be queried to enforcement even when local Room state is already ended. An absent creation past its deadline
  can be abandoned without sending a late create. Sign-out discards the local attempt and rejects
  late success; Room's existing initialization deadline cleans up stranded metadata/objects.
  Browser exit can still lose the unshared key or unconfirmed bytes; durable browser recovery is
  outside this unit.
- `findForScene` checks source ownership and returns only an initializing/ready display candidate,
  including an in-progress room so another attempt does not knowingly create a duplicate. The
  browser asks Room before opening it. An existing ready room is opened without a newly minted key;
  the original complete link or subsequent key-recovery/rotation work is required. DB candidate
  absence and concurrent creation are still bounded by the existing active-scene unique constraint.
- Joining checks the live encrypted verifier before preparing/claiming the canvas, then rechecks
  generation before acquiring an identity proof. Rotation is terminal even when the new generation
  remains initializing. Independent rooms never compare two NULL scene IDs as the same source canvas.
  The actual socket ACK continues to decide the live editor/viewer role.
- This initial slice refused image-bearing initialization before Room creation. The attachment unit
  below supersedes that refusal with the complete durable manifest; it still never omits an image or
  uses the old uploader to claim a partial canvas is ready.
- Sixteen new browser/store/UI/PGlite cases cover encrypted empty initialization, lost create and
  snapshot replies, exact request replay, receipt mismatch, pending completion, cancellation, sign-out,
  generation rotation, image refusal, proof-only joining and source candidate ownership/status.
  Existing workerd authority tests verify encrypted key-check metadata, and a new SQLite runtime
  case proves late old-generation key-checks cannot poison the rotated generation.
  These tests use fake Room/storage effects, real browser crypto and local PGlite; they do not establish
  deployed cross-cloud product acceptance.

No production schema/migration/reset/deployment or credentials changed in this initial slice. The
attachment extension follows below; remaining Room management and Lifecycle/deletion paths must
retire the old DB issuers/control outbox before the P3 controlled reset.

## 18B P2 product attachment authority

Source-only; the attachment unit extends the initialization above to image-bearing scenes. It uses
`POST /v1/assets`, the existing private service capability and a fresh identity proof. The protected
web resolver, UploadThing presign and verified provider callback now consult Room rather than DB roles.
The old `collab/assets.ts` DB-authorized writer/resolver is removed.

- Room authorizes owner-only initialization and current ready-room access before and after live
  registration. Reads ask the adapter for bounded current-generation records, then recheck roles,
  generation, epoch, proof and deadline before exposing any provider URLs. Viewer reads are allowed;
  viewer presign/finalization and non-owner initialization access are refused.
- Presign checks the immutable actorless intent against current generation/epoch/deadline. It does
  not stage bytes or reserve a durable content job. Only the verified UploadThing callback binds the
  actual provider key/URL/length. It reissues proof from the live original account/session, requiring
  unchanged lifecycle identity and verified email. Descriptor length must equal the bounded intent.
  Room then accepts `asset-finalize`, writes through the adapter's existing locks/fences, and commits
  the written receipt with its local initialization asset manifest. Alarms recover or cancel unknown
  accepted operations, including after eviction; no alarm retries ciphertext uploads.
- The browser retains bounded metadata for at most 512 unknown intents and permits one provider
  upload per intent. Retry queries the complete original browser intent/actor binding. A pending
  deadline may request storage cancellation; a written cancellation race is adopted. Only a terminal
  cancellation or Room-certified expired absence permits a new upload. Browser time alone never
  establishes absence. Recovery does not spend the publisher's three ordinary failure attempts.
- The intent checksum binds metadata to the browser's sealed payload; the server does not download
  provider objects to verify their hash or decrypt them. Browser asset opening still validates its
  authenticated envelope and payload identity. Provider URLs retain the accepted public ACL limitation.
- Unknown/refused callbacks enqueue cleanup under the same provider-object advisory lock as
  finalization. A referenced object is never queued, and queued garbage cannot later become a live
  reference. No callback directly deletes an object after an unknown write result. Cleanup driver
  failures are sanitized before the provider SDK can log SQL parameters containing object keys.
- The editor captures both elements and local image files before source lookup can yield. Initialization
  validates the complete bounded source manifest before creating a Room, publishes encrypted assets,
  confirms their current-generation availability, stores the encrypted snapshot, and completes with
  every referenced file ID. Pending attachments withhold the snapshot/ready link. Retry retains the
  same Room/key; unmount/sign-out disposes local transfers and refuses late continuation. Explicit
  cancellation still waits for the Room's enforced fence. Browser exit may lose an unshared key or
  unconfirmed bytes; there is no durable browser recovery.

Local validation adds 31 browser intent/recovery, verified callback/PGlite cleanup and encrypted image
initialization cases, plus 14 workerd authorization/race cases. The disposable Docker PostgreSQL suite
passes all 11 cases, including two new blocked-lock races for callback cleanup versus object adoption. The former DB-authorized asset test cases are
replaced by Room entry and existing adapter invariants; personal/shared scene identity tests remain.
These checks establish the local adapter lock behavior, not live UploadThing or deployed cross-cloud
acceptance; the remaining Lifecycle/product race gates still need their later P2 work.
No DB schema, production migration/reset, credentials or deployment changed. Remaining P2 work is
Room management/panel/projection integration, legacy issuer removal, Lifecycle/deletion entry points,
real PostgreSQL race gates and reset/rollback rehearsal before the coordinated P3 reset/deployment.

The production description below describes the existing deployment. The relay is a Cloudflare
Worker gateway plus one `CollaborationRoom` Durable Object per room generation
(`apps/collaboration-do`); durable collaboration data belongs to the web backend; encryption and
reconciliation run on clients.

## 18B P2 management, Lifecycle and cutover artifact

The source conversion is complete; production remains protocol 5 until the coordinated P3 reset. Room SQLite owns get-management, roles, leave/end, allowlist changes and generation rotation. Management pages independently bound members and email entries to 50; joined timestamps and negative decisions remain local. The dialog retains the immutable pending operation with a retry entry; rotation captures the encrypted baseline and attachments and releases the replacement key only after ready. Dashboard projection lists include independent Rooms; their keys remain in invitation fragments.

Lifecycle's private Gateway validates its service capability and dispatches a durable subject-scoped operation. Web entry points persist the same intent for retries. Freeze advances the lifecycle version and revokes account sessions; registration shares its lock order. Bounded enumeration includes preregistered Rooms without DB parents. Room retirement immediately fences local authorization and sockets, retains retired-subject tombstones and acknowledges only the adapter storage fence. Missing parents retain tombstones. Retries preserve the authority epoch. Lifecycle's alarm resumes after eviction and only cascades DB rows/enqueues storage cleanup after every required Room ACK.

Admin scene/account retirement, scene deletion, workspace deletion and account purge use that coordinator. Pending results retain the resource and report pending. Completed tombstones allow safe deletion retries. Better Auth self-delete is explicitly disabled because no self-delete product entry exists. Workspace cascade is allowed only after all source scenes have retired and a locked recheck proves the workspace empty; concurrent new scenes require retry. Ended Room retention also requires the terminal storage state before deleting rows.

The DB permission router/writers, web control tokens/outbox, public legacy control and generation socket routes, drain route/table and Worker minute cron are removed. Private legacy runtime RPC remains for regression coverage and has no public/product issuer. Operator smoke uses identity-only protocol-6 proofs and real verified accounts. Adapter fetch uses workerd-supported manual redirect handling and rejects every non-2xx response without forwarding capabilities.

Deployment preparation generates collaboration-only upgrade/rollback SQL without reading a database URL. PostgreSQL 17 rehearses protocol-5 → reset → protocol-6 → rollback → upgrade and compares full account, scene/shared/published, Library and attachment-reference values. The production Gateway harness verifies the maximum legal encrypted snapshot through write/read/decryption, attachment descriptor finalization, ready, WebSocket revoke and Lifecycle retirement. Workerd additionally tests failed fence ACK, durable eviction/retry, missing-parent tombstones and capacity fail-closed policy. See the [P3 runbook](../deployment/collaboration-reset/README.md) for manifests, writer isolation, paired deployment/rollback and remaining L3 acceptance. No production DB, secret, cron or deployment was changed by P2.

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

## Browser-side encryption, key custody, and key confirmation

The browser generates a random 32-byte room key and carries it in the URL fragment; the relay never
receives it. Since plan 19 (2026-10-09) the browser
also escrows it to Room DO custody through the dedicated `/v1/room-key` path, where it is stored
only wrapped under a key derived from `COLLAB_ROOM_KEY_WRAP_SECRET`, and members fetch it from there to
reopen a room (see [authority contract](./collaboration-authority.md)). HKDF
derives purpose-scoped keys for `realtime`, `snapshot`, `asset`, and `keycheck`, salted by room and
authorization generation. Each format has its own version and authenticated-data label.

Scope of the guarantee: browser-side encryption holds against passive relay operators, Neon and
UploadThing operators or leaks, and network intermediaries — none of them holds a key. It is not
end-to-end encryption: whoever holds `COLLAB_ROOM_KEY_WRAP_SECRET` and Room DO storage can unwrap the
custody copy (T17). It also does not hold against whoever controls the application code the
browser runs, because the key lives in that code's memory. That
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

1. Obtain the key from the fragment or, when it is absent, from Room custody; fetch room metadata
   and verify the key against the generation's key check. A bad or unavailable key stops before
   changing the canvas or minting a token. After a successful keyed join from a link the editor
   escrows the key again (backfill).
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
