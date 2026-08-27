import { describe, expect, it } from "vitest";

import type { DoLogger } from "../src/logger.ts";
import {
  OUTBOX_DRAIN_PING_TIMEOUT_MS,
  pingControlOutboxDrain,
} from "../src/outbox-drain.ts";

/**
 * The scheduled ping's own contract: it authorizes with the cron secret,
 * degrades every failure to a log line (a missed minute is repaired by the
 * next one), and never runs unconfigured. The drain semantics themselves are
 * covered in apps/web (`collaboration-control-outbox.test.ts`).
 */

type CapturedLog = { level: string; event: string; fields?: unknown };

function createCaptureLogger(): { records: CapturedLog[]; log: DoLogger } {
  const records: CapturedLog[] = [];
  const push = (level: string) => (event: string, fields?: unknown) =>
    records.push({ level, event, fields });
  return {
    records,
    log: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

const envWith = (overrides: Partial<Env>): Env =>
  ({
    COLLAB_OUTBOX_DRAIN_URL:
      "https://web.example/api/collaboration/control-outbox",
    COLLAB_CRON_SECRET: "test-cron-secret",
    ...overrides,
  }) as Env;

describe("pingControlOutboxDrain", () => {
  it("GETs the drain endpoint with the bearer secret and a bounded timeout", async () => {
    const { records, log } = createCaptureLogger();
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    await pingControlOutboxDrain(
      envWith({}),
      log,
      (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(Response.json({ delivered: 1 }));
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(
      "https://web.example/api/collaboration/control-outbox",
    );
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toEqual({
      authorization: "Bearer test-cron-secret",
    });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(OUTBOX_DRAIN_PING_TIMEOUT_MS).toBeLessThan(60_000);
    // A healthy minute is silent — logging every tick would be pure noise.
    expect(records).toEqual([]);
  });

  it("logs the HTTP status on a non-2xx drain response", async () => {
    const { records, log } = createCaptureLogger();
    await pingControlOutboxDrain(envWith({}), log, () =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    expect(records).toEqual([
      {
        level: "error",
        event: "cron.outbox_drain_failed",
        fields: { status: 401 },
      },
    ]);
  });

  it("logs a content-free error name when the web app is unreachable", async () => {
    const { records, log } = createCaptureLogger();
    await pingControlOutboxDrain(envWith({}), log, () =>
      Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED")),
    );
    expect(records).toEqual([
      {
        level: "error",
        event: "cron.outbox_drain_failed",
        fields: { errorName: "TypeError" },
      },
    ]);
  });

  it("refuses to fire unconfigured instead of pinging without authorization", async () => {
    const { records, log } = createCaptureLogger();
    let fetched = false;
    await pingControlOutboxDrain(
      envWith({ COLLAB_CRON_SECRET: undefined }),
      log,
      () => {
        fetched = true;
        return Promise.resolve(new Response(null));
      },
    );
    expect(fetched).toBe(false);
    expect(records).toEqual([
      { level: "error", event: "cron.outbox_drain_not_configured" },
    ]);
  });
});
