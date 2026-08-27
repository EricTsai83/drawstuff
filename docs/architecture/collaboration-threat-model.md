# Collaboration threat model and data-flow review

- Status: Current
- System design: [collaboration system design](./collaboration-system-design.md)
- Observability policy: [alerts and dashboards contract](../observability/collaboration-alerts-and-dashboards.md)
- Capacity and limits: [collaboration SLO](../performance/collaboration-slo-capacity.md)

This document identifies trust boundaries, data that crosses them, implemented controls, and
accepted gaps. Scene plaintext exists only in participating browsers.

## Trust boundaries

| Boundary | Sides                                | Reachability                                                                              |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| B1       | Browser ↔ relay WebSocket            | Logged-in users holding a valid short-lived join token                                    |
| B2       | Browser ↔ collaboration tRPC backend | Logged-in users; every procedure resolves room access                                     |
| B3       | Browser ↔ object-storage upload      | Room owner/editor with current generation                                                 |
| B4       | Web backend → relay control endpoint | A backend holding a signed, action-scoped control token                                   |
| B5       | URL fragment                         | Browser memory and user clipboard only; anyone with the complete link learns the room key |

Actors are room owner, editor, viewer, logged-in non-member, unauthenticated caller, relay operator,
backend/storage operator, and network intermediary.

## Cross-boundary data

| Data                      | Boundary | Form                                                                            | Readable by                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Scene and presence frames | B1       | AES-GCM ciphertext with one-byte channel prefix                                 | Room-key holders only                        |
| Join token                | B1       | HMAC claims for room, generation, subject, role, revision, expiry, and audience | Relay verifier; contains no key material     |
| Durable snapshot          | B2       | Ciphertext, ciphertext checksum, byte length, and optimistic revision           | Room-key holders; backend sees metadata only |
| Asset bytes               | B3       | Versioned sealed binary envelope                                                | Room-key holders only                        |
| Asset metadata            | B2       | File ID, crypto version, byte length, and storage URL                           | Backend                                      |
| Room lifecycle            | B2       | Membership, roles, generation/revision, expiry, status, and link role           | Backend                                      |
| Control token             | B4       | HMAC claims scoped to one room action                                           | Relay verifier                               |
| Room key                  | B5 only  | Random 32-byte value                                                            | Complete-link holders                        |

Three invariants follow:

1. Relay and backend are not scene readers.
2. Room and derived keys never enter mutations, logs, metrics, storage metadata, or error payloads.
3. Authorization comes from the backend; confidentiality comes from the fragment. A valid token
   without a valid room key is a supported and explicitly reported state.

## Untrusted-input controls

### Relay

| Input/resource    | Control                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Control frame     | Measure UTF-8 bytes before JSON parse; max 65,536 bytes                                                   |
| Data frame        | WebSocket `maxPayload` plus channel-specific sealed size (scene 1 MiB, presence 16 KiB plaintext budgets) |
| Control HTTP body | 4,096-byte streaming bound before decode                                                                  |
| Join token        | HMAC, audience, room, generation, TTL (60s default/300s max), room expiry, revision cutoff                |
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
| Room procedures    | Protected procedure, centralized access resolution, room-row lock for lifecycle writes, 12h default/24h max TTL, 20 joins/user/minute                                                                       | —           |
| Snapshot put       | Decode/size bound before transaction, ciphertext checksum, current generation, row lock, optimistic revision, 6 writes/room/minute; after an explicit refusal, leave-only reserve 2 writes/user/room/minute | —           |
| Asset resolve      | Access check, max 64 IDs per batch, 120 lookups/user/minute                                                                                                                                                 | —           |
| Asset upload       | One object/request, ciphertext size bound, owner/editor role, current generation, max 512 assets/generation, 60 presigns/user/minute                                                                        | —           |
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
limit stays fail-closed while that is happening — including authentication, room role, generation
currency, payload and batch bounds, and the 512-assets-per-generation cap. `degraded` never becomes
a 429, so it cannot consume a client's retry budget. Each limiter decision makes exactly one Redis
call and is never retried. Ordinary requests make one decision; only a leave snapshot explicitly
refused by the room budget checks the separate two-token finalization reserve, for at most two calls.
No path substitutes a process-local counter, which would present one independent limit per instance
as a global one.

### Client

The join buffer (256 messages/8 MiB), offline queue (2,048 elements/512 KiB/5 minutes), outbound
buffer (4 MiB), inbound pending queue (2 MiB), replay cache (4,096 entries/60 seconds), transfer
concurrency, retry attempts, and nonce budgets are all bounded. Destroy/switch/leave aborts in-flight
work and releases timers, object URLs, sockets, and caches.

## Threats and current disposition

| ID  | Threat                                                     | Control or accepted limitation                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Non-member reads room content                              | Every join requires an authorized short-lived token; generation rotation isolates old tokens and keys.                                                                                                                                                                                                                                               |
| T2  | Relay/operator/intermediary reads scene                    | All scene, presence, snapshot, and asset content is end-to-end encrypted; relay has no crypto key or persistence dependency.                                                                                                                                                                                                                         |
| T3  | Removed member remains online                              | Relay control disconnects live sockets and authorization-revision cutoff rejects earlier tokens. If control delivery fails, UI reports enforcement failure rather than claiming success.                                                                                                                                                             |
| T4  | Viewer mutates scene                                       | Relay rejects scene frames from viewer sessions; UI read-only state is secondary defense.                                                                                                                                                                                                                                                            |
| T5  | Oversize/buffer abuse                                      | Raw-byte bounds precede decode; connection, room, buffer, queue, replay, asset, and snapshot limits are explicit.                                                                                                                                                                                                                                    |
| T6  | Authorized caller amplifies load                           | Relay traffic/churn limits are implemented. Backend join, snapshot-write, asset-upload and asset-resolve rates are bounded by shared Redis counters that hold across serverless invocations; a real refusal is a 429 with a machine-readable reset, and Redis failure fails open as observable degradation while every hard guard stays fail-closed. |
| T7  | Room key leaks from shared link                            | Accepted limitation: the complete link is a bearer secret. UI identifies the fragment as the key; generation rotation is the cryptographic revocation path.                                                                                                                                                                                          |
| T8  | Telemetry leaks content or identity                        | Relay logger is the only sink, fields are a closed type plus runtime allowlist, metrics have bounded label sets, pre-verification failures log only enums, and integration tests scan complete logs/metrics for prohibited values. Subject IDs use per-process HMAC pseudonyms.                                                                      |
| T9  | Ended room retains ciphertext forever                      | Seven-day-grace retention deletes snapshot rows and transactionally enqueues asset objects for cleanup; expired active rooms become ended under lock.                                                                                                                                                                                                |
| T10 | One format-version change destroys unrelated durable data  | HKDF is purpose-scoped and version-neutral. Realtime AAD binds transport version; snapshot and asset payload/AAD bind only their own versions. Aggregate open-failure detection prevents silent wrong-key sessions while isolated corruption remains non-terminal.                                                                                   |
| T11 | Oversize local change silently stops sync                  | Client exposes a clearable blocked state and stops claiming synchronization until content is reduced.                                                                                                                                                                                                                                                |
| T12 | Fanout state is accidentally split across instances        | Structurally eliminated by the Durable Object architecture: each `(roomId, authGeneration)` maps to exactly one `CollaborationRoom` Object whose single-instance placement is platform-guaranteed; no process-wide room map exists.                                                                                                                                                                                                     |
| T13 | Client-selected identifier smuggles key material into logs | Eliminated at the source: there is no `clientId`; join carries room and token, peer identity is relay-created `peerId`. Before token verification even `roomId` is not logged.                                                                                                                                                                       |
| T14 | Wrong-key client seeds or overwrites snapshot              | Key check is verified before canvas takeover and join; missing verifier fails closed on both backend and client. A verifier is immutable within a generation, rotation clears/recomputes it, and owner can explicitly reset unreadable snapshot.                                                                                                     |
| T15 | Relay suppresses frames                                    | Accepted availability limitation. A relay can always drop or refuse traffic, and a quiet room is indistinguishable from suppression without false positives. Metrics expose routing inactivity; confidentiality is unaffected.                                                                                                                       |

## Observability data classification

Allowed fields are opaque `roomId` after verification, `authGeneration`, relay-created `peerId`,
byte counts, frame counts, channel enum, close/disconnect enums, aggregate decrypt/conflict counts,
snapshot revision, latency, event-loop lag, and memory. The backend rate limiter's degradation event
adds two closed enums — the operation and the cause (`timeout` or `exception`) — and nothing else:
it carries no identifier, no Redis endpoint, and no error payload, because an Upstash SDK error
message embeds the REST URL and the token it was called with.

Forbidden fields are email, display name/presence username, message content, ciphertext/base64
fragments, payload-derived error details, room/derived keys, token or token fragments, snapshot
ciphertext, and raw subject ID.

Metrics intentionally omit room and peer identifiers to prevent enumeration and cardinality growth.
Logs may use verified room/peer IDs, but token failure before verification records only a closed enum.
Raw subject ID is replaced with a 48-bit per-process HMAC pseudonym so it cannot be correlated across
relay restarts.

## Accepted monitoring limitations

Relay metrics and structured logs are implemented. Session-success, browser decrypt-failure, and
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
  `admin_audit_event`, without scene plaintext or room key material. Audit rows survive target
  account deletion.
- Storage deletion failures enter `deferred_file_cleanup`; room retirement advances authorization
  and pushes relay control so existing sessions are closed.
