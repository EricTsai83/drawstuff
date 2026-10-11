import "server-only";

import { z } from "zod";

import { env } from "@/env";

/**
 * Durable Object events an operator acts on (see the collaboration DO
 * observability doc). Read from Workers Logs rather than from the Objects:
 * the gateway deliberately has no debug surface, and these events matter
 * most exactly when the Objects cannot reach the web app to report them.
 */
const WORKER_ERROR_EVENTS = [
  "authority.work_abandoned",
  "alarm.given_up",
  "lifecycle.retirement_stuck",
  "lifecycle.retirement_parked",
  "adapter.delivery_failed",
  "authority.entry_failed",
  "room.frame_dispatch_failed",
  "room.schema_bootstrap_failed",
  "gateway.unhandled_failure",
  "gateway.config_invalid",
] as const;

const WINDOW_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 5_000;
/** One Cloudflare API call per instance per minute, however often the page loads. */
const CACHE_MS = 60_000;

const responseSchema = z.object({
  success: z.boolean().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
  result: z
    .object({
      calculations: z
        .array(
          z.object({
            aggregates: z.array(
              z.object({
                value: z.number(),
                groups: z
                  .array(
                    z.object({
                      key: z.string(),
                      value: z.union([z.string(), z.number(), z.boolean()]),
                    }),
                  )
                  .optional(),
              }),
            ),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type WorkerErrorEvents =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true;
      windowHours: number;
      counts: { event: string; count: number }[];
    };

let cache: { at: number; value: WorkerErrorEvents } | undefined;

/** Counts of each DO error event over the last 24 h; never throws. */
export async function readWorkerErrorEvents(
  now = Date.now(),
): Promise<WorkerErrorEvents> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_OBSERVABILITY_TOKEN;
  if (!accountId || !token) return { configured: false };
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  let value: WorkerErrorEvents;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          queryId: "drawstuff-admin-do-errors",
          timeframe: { from: now - WINDOW_MS, to: now },
          view: "calculations",
          dry: true,
          parameters: {
            calculations: [{ operator: "count", alias: "count" }],
            filterCombination: "or",
            filters: WORKER_ERROR_EVENTS.map((event) => ({
              key: "event",
              operation: "eq",
              type: "string",
              value: event,
            })),
            groupBys: [{ type: "string", value: "event" }],
            limit: WORKER_ERROR_EVENTS.length,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      },
    );
    const parsed = responseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success || parsed.data.success === false) {
      // Only the status and Cloudflare's own messages: never the token.
      const message = parsed.success
        ? parsed.data.errors?.map((error) => error.message).join("; ")
        : undefined;
      value = {
        configured: true,
        error: message
          ? `HTTP ${response.status}: ${message}`
          : `HTTP ${response.status}`,
      };
    } else {
      const counts = new Map<string, number>();
      for (const aggregate of parsed.data.result?.calculations?.[0]
        ?.aggregates ?? []) {
        const event = aggregate.groups?.find(
          (group) => group.key === "event",
        )?.value;
        if (typeof event === "string")
          counts.set(event, (counts.get(event) ?? 0) + aggregate.value);
      }
      value = {
        configured: true,
        windowHours: WINDOW_MS / (60 * 60_000),
        counts: WORKER_ERROR_EVENTS.map((event) => ({
          event,
          count: Math.round(counts.get(event) ?? 0),
        })),
      };
    }
  } catch (error) {
    value = {
      configured: true,
      error: error instanceof Error ? error.name : "unknown",
    };
  }
  cache = { at: now, value };
  return value;
}
