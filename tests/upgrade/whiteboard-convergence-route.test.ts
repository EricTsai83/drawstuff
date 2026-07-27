// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReadiness: vi.fn(),
  runBatch: vi.fn(),
}));

vi.mock("@/env", () => ({ env: { CRON_SECRET: "secret" } }));
vi.mock("@/server/whiteboard/data-convergence", () => ({
  getWhiteboardConvergenceReadiness: mocks.getReadiness,
  runWhiteboardConvergenceBatch: mocks.runBatch,
}));

import { GET, POST } from "@/app/api/maintenance/whiteboard-convergence/route";

function request(
  method: "GET" | "POST",
  body?: Readonly<Record<string, unknown>>,
  authorized = true,
): Request {
  return new Request(
    "https://drawstuff.example/api/maintenance/whiteboard-convergence",
    {
      method,
      headers: {
        ...(authorized ? { authorization: "Bearer secret" } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

describe("whiteboard convergence maintenance route", () => {
  beforeEach(() => {
    mocks.getReadiness.mockReset().mockResolvedValue({
      legacyDatabaseDocuments: 1,
      legacySharedDocuments: 2,
    });
    mocks.runBatch.mockReset().mockResolvedValue({
      audits: [],
      stoppedAfterFailure: false,
      nextCursor: null,
      hasMore: false,
    });
  });

  it("does not expose readiness without the maintenance secret", async () => {
    const response = await GET(request("GET", undefined, false));

    expect(response.status).toBe(401);
    expect(mocks.getReadiness).not.toHaveBeenCalled();
  });

  it("requires the production readiness acknowledgements before apply", async () => {
    const response = await POST(request("POST", { mode: "apply" }));

    expect(response.status).toBe(409);
    expect(mocks.runBatch).not.toHaveBeenCalled();
  });

  it("runs a bounded dry-run without write authority", async () => {
    const response = await POST(
      request("POST", {
        mode: "dry-run",
        batchSize: 10,
        abortAfterFailures: 2,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runBatch).toHaveBeenCalledWith({
      apply: false,
      cursor: undefined,
      batchSize: 10,
      abortAfterFailures: 2,
    });
    await expect(response.json()).resolves.toMatchObject({
      readiness: {
        legacyDatabaseDocuments: 1,
        legacySharedDocuments: 2,
      },
    });
  });

  it("passes apply authority only after every readiness gate is acknowledged", async () => {
    const response = await POST(
      request("POST", {
        mode: "apply",
        readiness: {
          inventoryComplete: true,
          snapshotCreated: true,
          restoreTested: true,
          zeroLegacyWrites: true,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runBatch).toHaveBeenCalledWith({
      apply: true,
      cursor: undefined,
      batchSize: 25,
      abortAfterFailures: 1,
    });
  });
});
