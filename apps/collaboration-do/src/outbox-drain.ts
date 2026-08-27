import { createDoLogger, errorNameOf, type DoLogger } from "./logger.ts";

/**
 * Minute-level scheduler for the durable collaboration control outbox.
 *
 * The durable outbox and its drain logic live in the web app
 * (`/api/collaboration/control-outbox`, authorized by the dedicated
 * `COLLAB_OUTBOX_CRON_SECRET` — deliberately not the maintenance
 * `CRON_SECRET`, so the secret this Worker holds can trigger nothing beyond
 * an idempotent drain); this Worker only supplies the clock, because the
 * Vercel deployment stays on the Hobby plan whose crons are daily-only. The
 * Worker deliberately holds no database access — the ping carries no data
 * and learns nothing beyond the HTTP status.
 *
 * Failure semantics: a missed or failed ping is never an outage by itself —
 * the next minute retries, and the outbox's claim leases/backoff make
 * duplicate or delayed drains safe. Only failures are logged; a healthy
 * ping every minute would be pure noise.
 */

/** Well under the drain route's own 60s envelope. */
export const OUTBOX_DRAIN_PING_TIMEOUT_MS = 30_000;

export async function pingControlOutboxDrain(
  env: Env,
  log: DoLogger = createDoLogger(env.VERSION_METADATA),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const drainUrl = env.COLLAB_OUTBOX_DRAIN_URL;
  const cronSecret = env.COLLAB_CRON_SECRET;
  if (!drainUrl || !cronSecret) {
    log.error("cron.outbox_drain_not_configured");
    return;
  }
  try {
    const response = await fetchImpl(drainUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(OUTBOX_DRAIN_PING_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.error("cron.outbox_drain_failed", { status: response.status });
    }
    // Release the connection; the drain report body is not consumed here.
    await response.body?.cancel();
  } catch (error) {
    log.error("cron.outbox_drain_failed", { errorName: errorNameOf(error) });
  }
}
