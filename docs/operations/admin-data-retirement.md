# Administrative data retirement operations

- Status: Current
- Lifecycle contract: [data lifecycle](../architecture/data-lifecycle.md)
- Database procedure: [engineering conventions](./engineering-conventions.md#database-schema)

This runbook provisions the first Drawstuff operator and invokes the server-only retirement API.
Authentication, authorization, and bootstrap are deliberately separate:

1. Google and Better Auth authenticate a person and create `user` plus `account` rows.
2. The one-time bootstrap command resolves a verified Google-linked email to Better Auth `user.id`.
3. `admin_grant` stores the durable `operator` role under that ID.
4. Every `adminProcedure` request checks the active DB grant; email is no longer involved.

There is no `ADMIN_USER_IDS` or `ADMIN_USER_EMAILS` production setting.

## Before the first production rollout

The change renames the application table namespace from `excalidraw-ericts_*` to `drawstuff_*` and
adds `drawstuff_admin_grant` plus `drawstuff_admin_audit_event`. Do not point an unreviewed schema
push at production. Follow the repository database convention:

1. Create a production-shaped database clone or restore a recent production backup to an isolated
   database.
2. Point all `POSTGRES_*` variables in a local, temporary environment at that clone.
3. Confirm the clone contains the expected Better Auth tables and record row counts for `user`,
   `account`, `session`, `scene`, and `collaboration_room`.
4. If the database already contains the old prefix, do not run the final `drawstuff_*`-filtered
   config directly: Drizzle Kit 0.31.10 applies `tablesFilter` while introspecting, so it cannot see
   `excalidraw-ericts_*` rows and cannot infer a rename. First run a controlled clone migration with
   a temporary transition config that includes both prefixes. Inspect every rename decision.
   Existing tables and columns must be recognized as renames that preserve rows; the only newly
   created tables must be the two admin tables with their indexes, checks, and foreign keys. Stop if
   Drizzle proposes dropping/recreating an existing table, reports destructive changes, or asks for
   force.
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm knip`.
6. Verify the production provider's backup/restore mechanism and capture a fresh recovery point.
7. During a controlled deployment window, repeat the clone-proven transition against production,
   capture the output, then deploy the final config whose filter is only `drawstuff_*`. A fresh
   database with no old-prefix tables may use the final `pnpm db:push` directly.
8. Confirm all application tables use the `drawstuff_` prefix, both new tables exist, and all
   pre-existing row counts are unchanged. Re-running `pnpm db:push` should report no remaining
   schema change.

No application environment variable identifies an administrator, so the web deployment can occur
before or after the schema push, but admin procedures will fail until the tables exist. Prefer schema
push first, then application deployment.

## Provision the first administrator

Use `eric492718@gmail.com` as the bootstrap lookup only. It will not be stored as the authorization
key.

1. Deploy the schema and application as described above.
2. Open the production site and sign in once using Google account `eric492718@gmail.com`. This is
   required so Better Auth creates the production `user` and Google `account` rows.
3. Use a trusted operator machine or protected one-off release job with the production server-side
   environment variables. Do not expose `POSTGRES_URL` to a browser or client-visible CI log.
4. From the repository root run:

   ```sh
   pnpm admin:bootstrap --email eric492718@gmail.com
   ```

5. A successful first run prints the resolved Better Auth ID and `Granted operator access`. Running
   the same command again is safe and reports that the same account is already an operator.
6. Verify without changing data:

   ```sql
   SELECT user_id, role, grant_source, granted_at, revoked_at
   FROM "drawstuff_admin_grant";

   SELECT actor_user_id, action, target_type, target_id, status, occurred_at
   FROM "drawstuff_admin_audit_event"
   ORDER BY occurred_at DESC
   LIMIT 10;
   ```

Expected results are one active `operator` grant with source `bootstrap` and one successful
`grant-admin` audit event.

The command fails closed when the email is absent, unverified, not linked to Google, or a different
active administrator already exists. After the first grant, bootstrap cannot provision another
account. An existing operator uses the audited grant/revoke procedures for later access changes;
bootstrap is never reused as a general grant mechanism.

## Invoke retirement procedures

Sign in as an active operator and open `/admin`. The management interface supports user search,
operator grants, scene and account retirement, room termination, and recent audit inspection. Every
user's **Manage** action opens `/admin/users/[userId]`, where high-risk actions require the immutable
target ID to be typed before submission. The underlying audited procedures are:

- `admin.retireScene({ sceneId })`
- `admin.endRoom({ roomId })`
- `admin.retireAccount({ userId, confirmUserId: userId })`
- `admin.grantOperator({ userId, confirmUserId: userId })`
- `admin.revokeOperator({ userId, confirmUserId: userId })`
- `admin.retryFailedCleanup({ target: taskId | "all" })` — requeues `failed`
  `deferred_file_cleanup` rows for the next maintenance drain
- `admin.resumeRetirement({ scope })` — re-sends `begin` for a frozen, unretired subject
  (`account:<id>` / `scene:<id>`) with its recorded operation; the Lifecycle Object retries now
- `admin.closeRoomStorage({ roomId })` — writes the terminal storage fence an ended room never
  delivered (no-op unless `status=ended` and `storage_state≠ended`)
- `admin.runRoomRetention()` — one routine room-retention pass with its usual caps

## Anomalies

The **Needs attention** section of `/admin` is computed from Neon only (`admin.anomalies`); each group
shows its total, most recent occurrence, and up to 50 oldest rows. Thresholds are owner decisions
(plan 22) in `apps/web/src/server/admin/anomalies.ts`.

| Group | Condition | Action |
| --- | --- | --- |
| Stuck retirement | lifecycle subject `frozen`, not `retired`, `frozen_at` over 1 h ago (or null: frozen before the column existed) | Resume (`resumeRetirement`); link to the user |
| Ended room, storage open | `status=ended`, `storage_state≠ended`, ended over 1 h ago | Close storage (`closeRoomStorage`) |
| Stuck initializing | `status=initializing` 15 min past `initialization_deadline` | End room (`endRoom`) |
| Failed file cleanup | `deferred_file_cleanup.status=failed` | Retry in the failed-cleanup section |
| Ended room still holding data | ended over 8 days ago (retention grace is 7) with any retention-reclaimable data | Run reclaim (`runRoomRetention`) |

`collaboration_lifecycle_subject.frozen_at` is a nullable column added for this view: run `db:push`
before deploying code that reads it.

## Maintenance

The **Maintenance** section of `/admin` (`admin.maintenanceStatus`) shows:

- the collaboration Worker's `/healthz` (reachable, configuration ready, deployed version);
- the last 10 maintenance runs from `maintenance_run` — cron, manual `POST` and admin runs are all
  recorded with per-job outcomes (a missing weekly row means the cron did not run);
- the cleanup queue backlog by reason (count, oldest, highest attempts) and how many rows are due.

**Run maintenance now** posts to `/api/admin/maintenance` (operator session, JSON only, audited
`run-maintenance`), which runs the same routine set as the cron under the same advisory lock and
`maxDuration` (a concurrent run is reported as skipped). Use it after retrying failed cleanup or
resuming a retirement so queued deletions happen without waiting for Monday. `maintenance_run` is a
new table: run `db:push` before deploying.

Account retirement rejects the currently authenticated administrator. Do not replace these calls
with SQL deletion. After an operation, verify its `admin_audit_event` status and inspect
`deferred_file_cleanup` for the enqueued storage keys — retirement never deletes storage objects
inline; routine maintenance's bounded queue drain deletes them. For room operations, also confirm
relay enforcement was reported.

Granting requires an existing, email-verified Better Auth account linked to Google. Operators
cannot revoke themselves; another active operator must perform the revocation, preventing an
accidental zero-admin state during normal operation.

## Authorization evaluation points

- The authenticated Canvas starts a non-blocking, user-keyed access query and shows **Admin
  console** in the main menu only when it returns `isOperator: true`. The result is a short-lived UI
  hint; the Canvas does not wait for it before rendering and never treats it as authorization.
- Entering `/admin` or `/admin/users/[userId]` runs a server-side session check followed by an
  active `admin_grant` lookup before the privileged page renders. Unauthenticated users are sent to
  login; authenticated non-operators receive the not-found boundary.
- Every admin tRPC query and mutation independently repeats the active-grant lookup through
  `adminProcedure`. Page authorization therefore improves routing and avoids rendering the UI, but
  API authorization remains the actual security boundary.

## Recovery and access review

- Revocation is represented by setting `admin_grant.revoked_at`; request authorization checks it on
  every call. Do not delete the audit history.
- Keep production DB and deployment access protected by MFA and limited to maintainers who may
  provision privileged identities.
- Review active grants periodically and after personnel or Google-account changes.
- A lost sole-admin account is a break-glass database operation. Restore access only through a
  documented incident, recorded approval, verified Google identity, and a new audit record; do not
  weaken the normal bootstrap invariant to make recovery convenient.

## Controls

The **Controls** section (`admin.opsControls`):

- **Collaboration switch** (`setCollabRoomsDisabled`, audited `disable-collaboration` /
  `enable-collaboration`): stored in `ops_setting`, read by `collaborationRoomsDisabled()` with a
  15 s per-instance cache, so it reaches every server within ~15 s without a redeploy. The
  `COLLAB_ROOMS_DISABLED` env var stays the break-glass override and always wins; the console shows
  when it is set.
- **Signals**: counts of events that otherwise exist only in logs — today
  `ratelimit.degraded:<operation>` (Upstash failing open). Written to `ops_signal` at most once a
  minute per instance; *Reset counters* (audited `reset-ops-signals`) clears them.

`ops_setting` and `ops_signal` are new tables: run `db:push` before deploying.
