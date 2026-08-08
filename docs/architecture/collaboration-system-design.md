# Collaboration system design

- Status: Current
- Security model: [collaboration threat model](./collaboration-threat-model.md)
- Capacity contract: [collaboration SLO](../performance/collaboration-slo-capacity.md)
- Deployment contract: [relay deployment envelope](../operations/collaboration-relay-deployment.md)

This document describes the collaboration system as it exists today. The relay is an independent,
single-process service; durable collaboration data belongs to the web backend; encryption and
reconciliation run on clients.

## Components and data flow

```text
browser
  ├─ native elements ─→ @drawstuff/excalidraw-adapter (official reconcile semantics)
  ├─ encrypted realtime frames ⇄ collaboration relay (opaque bounded fanout)
  └─ encrypted snapshot/asset requests ⇄ apps/web ⇄ PostgreSQL/object storage
```

`@drawstuff/collaboration` owns transport-neutral messages, validation, crypto, ordering, join
barriers, offline queues, and recovery policy. `apps/web` binds those contracts to authenticated
room APIs and the editor. The relay imports only server-safe protocol entries; it cannot decrypt or
persist a scene.

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

Room mutation paths lock the room row, re-evaluate authorization, commit state, and only then send
relay control. This serializes token issuance with membership, end-room, and generation changes.

## Protocol and delivery semantics

Every network payload is byte-bounded before strict runtime decoding. Transport protocol version is
independent from native document and durable payload versions.

The relay provides session ordering, not durable or exactly-once delivery. Scene and presence use
separate channels:

- scene frames are reliable within a live socket session and are rejected when sender role or
  limits disallow them;
- presence may be dropped under backpressure;
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

- Realtime uses AES-GCM with a fresh random 96-bit IV per message and an enforced per-sender seal
  budget. Its AAD includes the transport version because realtime frames are transport data.
- Snapshot and asset AAD do not contain transport version. Their payload and envelope versions
  evolve independently, so a realtime protocol change cannot invalidate durable ciphertext.
- The room row stores a fixed-size encrypted key-check value. Clients verify it before taking over
  or clearing the canvas and before requesting a join token. Its AAD and derived key bind room and
  generation. Missing checks fail closed, and the server also refuses to issue a join token.
- A verifier cannot change inside one generation. Rotation clears it and the owner recomputes it
  with the new key. The owner can explicitly reset an unreadable snapshot after confirmation.

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
forced leave flush share authorization, role, generation, baseline-known, and revision guards.
Joining a room claims the tab's canvas independently of cloud scene ownership; a guest never saves
over the owner's scene. Replacing or clearing the canvas releases the claim and tears down
collaboration-owned resources.

Recovery classifies disconnects into terminal, retryable, and generation-rotation outcomes. A
bounded exponential backoff reconnects, obtains a new `peerId`, rebuilds presence, and uses the same
join barrier to converge. Relay restart never touches PostgreSQL or owned-scene state.

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

- The relay is intentionally a single instance with process-local fanout. Its hard limits and
  graceful restart behavior are part of the deployment envelope.
- Relay-side connection and frame rate limits are implemented. Shared backend limits for join,
  snapshot writes, asset uploads, and asset resolution remain required before public testing; see
  [backend rate limits](../../plans/backend-rate-limits.md).
- Relay metrics and privacy-safe structured logs exist. Client/session success, decrypt-failure,
  and snapshot-conflict SLOs currently have no telemetry carrier.
- There is no staged rollout cohort system, collaboration-specific kill switch, staging environment,
  formal capacity load test, or complete incident runbook. These are accepted operating limits for
  the current personally operated, limited-public-test service.
