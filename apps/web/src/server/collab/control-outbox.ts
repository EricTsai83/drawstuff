import "server-only";

import { and, count, eq, inArray, lt, lte, or } from "drizzle-orm";

import { pushDoRoomControl } from "@/server/collab/do-control";
import {
  classifyControlPushError,
  type RoomControlPushParams,
  type RoomControlPushResult,
} from "@/server/collab/control-token";
import type { Database, RoomDatabase } from "@/server/collab/rooms";
import {
  collaborationControlOutbox,
  type RoomControlFailure,
} from "@/server/db/schema";

/**
 * Durable control outbox: the delivery mechanism between a committed room
 * mutation and its enforcement on the Durable Object.
 *
 * Every lifecycle mutation inserts its enforcement intent in the same
 * transaction as the authorization change, so the two can never diverge:
 * either both committed or neither did. After the commit the caller makes
 * one synchronous best-effort dispatch for fast UI feedback; anything that
 * fails stays `pending` and is drained by the minute-level schedule
 * (`/api/collaboration/control-outbox`, fired by the collaboration Worker's
 * cron trigger — the Vercel plan's crons are daily-only), never by the
 * weekly storage cleanup. Deliveries use revision-max idempotent cutoffs, so
 * an ambiguous timeout is always safe to resend.
 *
 * No signed token is ever stored — each delivery signs a fresh short-lived
 * control token at dispatch time.
 */

export type ControlOutboxEvent = typeof collaborationControlOutbox.$inferSelect;

/** After this many attempts an event is a poison event: terminal, visible. */
export const MAX_CONTROL_OUTBOX_ATTEMPTS = 10;

/**
 * Claiming pushes `next_attempt_at` this far forward, so a drainer that dies
 * mid-dispatch leases the event rather than losing it: it simply becomes due
 * again. Redelivery after a crashed drainer is covered by idempotency.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 10 * 60_000;

/** Events claimed per drain run; one run stays well inside its route budget. */
export const DEFAULT_DRAIN_MAX_EVENTS = 25;

/** Parallel dispatches per batch — same bound as the retirement pushes. */
const DISPATCH_BATCH = 5;

/** Rows removed per retention run, keeping the weekly job bounded. */
const RETENTION_MAX_ROWS = 500;
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type EnqueueRoomControlParams = {
  roomId: string;
  authGeneration: number;
  /** The revision this mutation produced; the Durable Object cutoff. */
  authRevision: number;
  now: Date;
} & (
  { action: "revoke-member"; subjectUserId: string } | { action: "end-room" }
);

/**
 * Records the enforcement intent. Must be called on the same transaction as
 * the room mutation it enforces — the insert-with-the-mutation atomicity is
 * the whole point of the outbox.
 */
export async function enqueueRoomControlEvent(
  db: RoomDatabase,
  params: EnqueueRoomControlParams,
): Promise<ControlOutboxEvent> {
  const [event] = await db
    .insert(collaborationControlOutbox)
    .values({
      roomId: params.roomId,
      authGeneration: params.authGeneration,
      authRevision: params.authRevision,
      action: params.action,
      subjectUserId:
        params.action === "revoke-member" ? params.subjectUserId : null,
      nextAttemptAt: params.now,
      createdAt: params.now,
      updatedAt: params.now,
    })
    .returning();
  if (!event) throw new Error("failed to enqueue room control event");
  return event;
}

/** Exponential backoff with ±25% jitter, capped below the poison horizon. */
export function backoffDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

function controlParamsOf(
  event: ControlOutboxEvent,
  now: Date,
): RoomControlPushParams {
  const common = {
    roomId: event.roomId,
    authGeneration: event.authGeneration,
    authRevision: event.authRevision,
    now,
  };
  if (event.action === "revoke-member") {
    // The column constraint guarantees a subject; this guard keeps the type
    // system honest if a row ever bypassed it.
    if (event.subjectUserId === null) {
      throw new Error(`outbox event ${event.eventId} lacks a subject`);
    }
    return { ...common, action: "revoke-member", userId: event.subjectUserId };
  }
  return { ...common, action: "end-room" };
}

/**
 * One delivery attempt to the Durable Object gateway. Signs a fresh control
 * token inside the push.
 */
async function pushToProvider(
  event: ControlOutboxEvent,
  now: Date,
): Promise<RoomControlPushResult> {
  const params = controlParamsOf(event, now);
  return pushDoRoomControl(params);
}

async function markDelivered(
  db: Database,
  event: ControlOutboxEvent,
  now: Date,
): Promise<void> {
  await db
    .update(collaborationControlOutbox)
    .set({
      status: "delivered",
      attempts: event.attempts + 1,
      lastFailure: null,
      deliveredAt: now,
      updatedAt: now,
    })
    .where(eq(collaborationControlOutbox.eventId, event.eventId));
}

/** Records one failed attempt; reports whether the row went terminal. */
async function recordDispatchFailure(
  db: Database,
  event: ControlOutboxEvent,
  failure: RoomControlFailure,
  now: Date,
): Promise<"poisoned" | "retried"> {
  const attempts = event.attempts + 1;
  if (attempts >= MAX_CONTROL_OUTBOX_ATTEMPTS) {
    // Terminal, observable poison state instead of an endless hot loop; the
    // row stays until retention so an operator can see what never landed.
    await db
      .update(collaborationControlOutbox)
      .set({ status: "failed", attempts, lastFailure: failure, updatedAt: now })
      .where(eq(collaborationControlOutbox.eventId, event.eventId));
    return "poisoned";
  }
  await db
    .update(collaborationControlOutbox)
    .set({
      attempts,
      lastFailure: failure,
      nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
      updatedAt: now,
    })
    .where(eq(collaborationControlOutbox.eventId, event.eventId));
  return "retried";
}

/**
 * Dispatches one event and persists the outcome. Used by both the post-commit
 * synchronous attempt and the cron drainer; the two may race over the same
 * event, which is safe — deliveries are idempotent and the row converges on
 * whichever outcome wrote last.
 *
 * Never throws: everything here runs after the mutation committed, so a
 * dispatcher that throws (instead of returning the closed result union) is
 * classified and recorded like any other failed attempt — it counts toward
 * the poison cap rather than being reclaimed forever — and a bookkeeping
 * write that fails degrades to `pending`, leaving the durable row for a
 * later drain instead of surfacing an error for a change that already
 * happened.
 *
 */
export async function dispatchControlOutboxEvent(
  db: Database,
  event: ControlOutboxEvent,
  now: Date = new Date(),
): Promise<RoomControlPushResult> {
  return (await dispatchAndRecord(db, event, now)).result;
}

/**
 * What actually got written for one dispatch — the drain's report counts
 * these, never a recomputation from stale in-memory attempts, so a
 * bookkeeping write that failed can never masquerade as a terminal state.
 * `leased` means the row was left untouched (bookkeeping failure or the DO
 * kill switch) and its claim lease decides when it becomes due again.
 */
type PersistedDispatchOutcome = "delivered" | "retried" | "poisoned" | "leased";

async function dispatchAndRecord(
  db: Database,
  event: ControlOutboxEvent,
  now: Date,
): Promise<{
  result: RoomControlPushResult;
  persisted: PersistedDispatchOutcome;
}> {
  let result: RoomControlPushResult;
  try {
    result = await pushToProvider(event, now);
  } catch (error) {
    result = { enforced: false, ...classifyControlPushError(error) };
  }
  try {
    if (result.enforced) {
      await markDelivered(db, event, now);
      return { result, persisted: "delivered" };
    }
    return {
      result,
      persisted: await recordDispatchFailure(db, event, result.failure, now),
    };
  } catch {
    // An enforced delivery whose bookkeeping failed is still enforced; the
    // row is redelivered later, which is idempotent. A failed delivery whose
    // bookkeeping failed keeps its claim lease and becomes due again.
    return { result, persisted: "leased" };
  }
}

export type ControlOutboxDrainReport = {
  claimed: number;
  delivered: number;
  retried: number;
  poisoned: number;
  /** Due events left behind (lease misses, caps, paused DO dispatch). */
  remainingDue: number;
};

function dueEventsFilter(now: Date) {
  return and(
    eq(collaborationControlOutbox.status, "pending"),
    lte(collaborationControlOutbox.nextAttemptAt, now),
  );
}

/**
 * Bounded drain of due events. Claiming happens in one short transaction —
 * `FOR UPDATE SKIP LOCKED` plus a lease bump on `next_attempt_at` — so
 * concurrent drainers (overlapping cron fires, a manual run) partition the
 * queue instead of double-claiming it, and no lock is ever held across a
 * network call. Dispatches then run outside the transaction in small
 * parallel batches.
 */
export async function drainControlOutbox(params: {
  db: Database;
  now?: () => Date;
  maxEvents?: number;
}): Promise<ControlOutboxDrainReport> {
  const now = params.now ?? (() => new Date());
  const maxEvents = params.maxEvents ?? DEFAULT_DRAIN_MAX_EVENTS;
  const db = params.db;
  const claimedAt = now();
  const claimed = await db.transaction(async (tx) => {
    const dueEvents = await tx
      .select()
      .from(collaborationControlOutbox)
      .where(dueEventsFilter(claimedAt))
      .orderBy(collaborationControlOutbox.nextAttemptAt)
      .limit(maxEvents)
      .for("update", { skipLocked: true });
    if (dueEvents.length > 0) {
      await tx
        .update(collaborationControlOutbox)
        .set({
          nextAttemptAt: new Date(claimedAt.getTime() + CLAIM_LEASE_MS),
          updatedAt: claimedAt,
        })
        .where(
          inArray(
            collaborationControlOutbox.eventId,
            dueEvents.map((event) => event.eventId),
          ),
        );
    }
    return dueEvents;
  });

  let delivered = 0;
  let retried = 0;
  let poisoned = 0;
  for (let start = 0; start < claimed.length; start += DISPATCH_BATCH) {
    const results = await Promise.all(
      claimed
        .slice(start, start + DISPATCH_BATCH)
        // Contractually non-throwing: a dispatcher exception is recorded as
        // a classified failed attempt, so it counts toward the poison cap.
        .map((event) => dispatchAndRecord(db, event, now())),
    );
    for (const { persisted } of results) {
      if (persisted === "delivered") delivered += 1;
      else if (persisted === "poisoned") poisoned += 1;
      else retried += 1;
    }
  }

  // What a capped run leaves behind must be visible.
  const [remaining] = await db
    .select({ value: count() })
    .from(collaborationControlOutbox)
    .where(dueEventsFilter(now()));
  return {
    claimed: claimed.length,
    delivered,
    retried,
    poisoned,
    remainingDue: remaining?.value ?? 0,
  };
}

/**
 * Bounded retention for terminal rows, run by the weekly storage cleanup.
 * Delivered rows are short-lived evidence; poison rows are kept longer so a
 * silent enforcement gap stays observable.
 */
export async function purgeControlOutboxRows(
  db: Database,
  now: Date,
): Promise<number> {
  const deliveredCutoff = new Date(now.getTime() - DELIVERED_RETENTION_MS);
  const failedCutoff = new Date(now.getTime() - FAILED_RETENTION_MS);
  const purgeable = db
    .select({ eventId: collaborationControlOutbox.eventId })
    .from(collaborationControlOutbox)
    .where(
      or(
        and(
          eq(collaborationControlOutbox.status, "delivered"),
          lt(collaborationControlOutbox.updatedAt, deliveredCutoff),
        ),
        and(
          eq(collaborationControlOutbox.status, "failed"),
          lt(collaborationControlOutbox.updatedAt, failedCutoff),
        ),
      ),
    )
    .orderBy(collaborationControlOutbox.updatedAt)
    .limit(RETENTION_MAX_ROWS);
  const purged = await db
    .delete(collaborationControlOutbox)
    .where(inArray(collaborationControlOutbox.eventId, purgeable))
    .returning({ eventId: collaborationControlOutbox.eventId });
  return purged.length;
}
