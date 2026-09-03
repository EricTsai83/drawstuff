// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The route's own responsibilities: cron-secret authorization and handing a
 * bounded drain to the outbox module. Drain mechanics are covered in
 * `collaboration-control-outbox.test.ts`.
 */
const { drainCalls, drainReport } = vi.hoisted(() => ({
  drainCalls: [] as unknown[],
  drainReport: {
    claimed: 1,
    delivered: 1,
    retried: 0,
    poisoned: 0,
    remainingDue: 0,
  },
}));
const { envState } = vi.hoisted(() => {
  const envState: { COLLAB_OUTBOX_CRON_SECRET: string | undefined } = {
    COLLAB_OUTBOX_CRON_SECRET: "test-outbox-cron-secret",
  };
  return { envState };
});
vi.mock("@/env", () => ({ env: envState }));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/collab/control-outbox", () => ({
  drainControlOutbox: (params: unknown) => {
    drainCalls.push(params);
    return Promise.resolve(drainReport);
  },
}));

import { GET } from "@/app/api/collaboration/control-outbox/route";

const request = (authorization?: string) =>
  new Request("http://localhost/api/collaboration/control-outbox", {
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  drainCalls.length = 0;
  envState.COLLAB_OUTBOX_CRON_SECRET = "test-outbox-cron-secret";
});

describe("collaboration control outbox cron route", () => {
  it("refuses a missing or wrong outbox secret without touching the queue", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong-secret"))).status).toBe(401);
    expect(drainCalls).toEqual([]);
  });

  it("fails closed while the outbox secret is unprovisioned", async () => {
    // Unset must not fall back to accepting CRON_SECRET (or anything else):
    // the whole point of the separate secret is that the maintenance secret
    // never authorizes this route, and vice versa.
    envState.COLLAB_OUTBOX_CRON_SECRET = undefined;
    expect((await GET(request("Bearer test-outbox-cron-secret"))).status).toBe(
      401,
    );
    expect((await GET(request("Bearer undefined"))).status).toBe(401);
    expect(drainCalls).toEqual([]);
  });

  it("drains once per authorized run and reports the outcome", async () => {
    const response = await GET(request("Bearer test-outbox-cron-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(drainReport);
    expect(drainCalls).toHaveLength(1);
  });
});
