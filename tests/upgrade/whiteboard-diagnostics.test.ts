import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: diagnosticMocks.getServerSession,
}));

import { POST } from "@/app/api/whiteboard-diagnostics/route";

describe("whiteboard diagnostics boundary", () => {
  beforeEach(() => {
    diagnosticMocks.getServerSession.mockReset();
    diagnosticMocks.getServerSession.mockResolvedValue({
      user: { id: "diagnostic-user" },
    });
  });

  it("accepts only aggregate version and failure fields", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(
      new Request("https://drawstuff.test/api/whiteboard-diagnostics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "save",
          outcome: "failure",
          documentVersion: 1,
          errorCode: "NETWORK",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(info).toHaveBeenCalledWith("whiteboard-diagnostic", {
      operation: "save",
      outcome: "failure",
      documentVersion: 1,
      errorCode: "NETWORK",
    });
  });

  it("rejects scene content, asset data, identifiers, and free-form errors", async () => {
    const response = await POST(
      new Request("https://drawstuff.test/api/whiteboard-diagnostics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "load",
          outcome: "failure",
          documentVersion: 1,
          sceneId: "private-scene",
          content: [{ id: "secret" }],
          assetData: "data:image/png;base64,secret",
          error: "arbitrary private error",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects unauthenticated log submissions", async () => {
    diagnosticMocks.getServerSession.mockResolvedValue(null);
    const response = await POST(
      new Request("https://drawstuff.test/api/whiteboard-diagnostics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "load",
          outcome: "success",
          documentVersion: 2,
        }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
