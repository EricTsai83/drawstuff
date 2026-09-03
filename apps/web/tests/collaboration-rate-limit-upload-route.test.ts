// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The upload route's rate limit, at the only request that may carry it.
 *
 * UploadThing 7.7.4 has no `TOO_MANY_REQUESTS` error code, so a limit thrown
 * from the FileRoute middleware would reach the client as a 400 or a 500 —
 * indistinguishable from "this upload is invalid", which is the opposite of
 * what a rate limit means. The wrapper exists to issue a real 429, and these
 * tests pin the three things that makes it correct: it counts the client's
 * presign request, it counts nothing else that arrives on the same path, and
 * anything it does not refuse is handed to UploadThing untouched.
 */

const delegated: string[] = [];
vi.mock("uploadthing/next", () => ({
  createRouteHandler: () => ({
    GET: () => new Response("get"),
    POST: (request: Request) => {
      delegated.push(request.url);
      return new Response(JSON.stringify({ delegated: true }), { status: 200 });
    },
  }),
}));

/** The real router pulls in the database and the whole collaboration stack. */
vi.mock("@/app/api/uploadthing/core", () => ({ uploadRouter: {} }));

let session: { user: { id: string } } | null = { user: { id: "user-a" } };
vi.mock("@/lib/auth/server", () => ({
  getServerSession: () => Promise.resolve(session),
}));

type Decision =
  | { status: "allowed" }
  | { status: "degraded" }
  | { status: "limited"; reset: number; retryAfterMs: number };

const checks: { operation: string; identifier: string }[] = [];
let decision: Decision = { status: "allowed" };
vi.mock("@/server/rate-limit/collaboration", () => ({
  checkCollaborationRateLimit: (input: {
    operation: string;
    identifier: string;
  }) => {
    checks.push(input);
    return Promise.resolve(decision);
  },
}));
vi.mock("@/server/rate-limit/shared-scene", () => ({
  checkSharedSceneRateLimit: (input: {
    operation: string;
    identifier: string;
  }) => {
    checks.push(input);
    return Promise.resolve(decision);
  },
}));

import { NextRequest } from "next/server";

import { COLLAB_RATE_LIMITED_ERROR } from "@/lib/collab/rate-limit";
import { POST } from "@/app/api/uploadthing/route";

const ENDPOINT = "http://localhost/api/uploadthing";

const request = (
  query: string,
  headers: Record<string, string> = {},
): NextRequest =>
  new NextRequest(`${ENDPOINT}${query}`, { method: "POST", headers });

/** What the client's `genUploader` sends to obtain an upload presign. */
const presign = (headers?: Record<string, string>) =>
  request("?actionType=upload&slug=collaborationAssetUploader", headers);

beforeEach(() => {
  delegated.length = 0;
  checks.length = 0;
  session = { user: { id: "user-a" } };
  decision = { status: "allowed" };
});

describe("what the collaboration upload limit counts", () => {
  it("counts the authenticated presign request, charged to the caller", async () => {
    await POST(presign());
    expect(checks).toEqual([
      { operation: "asset-upload", identifier: "user-a" },
    ]);
  });

  it("does not count UploadThing's completion callback", async () => {
    // Same path, same slug, but server-to-server traffic the user did not make.
    // Counting it would let a busy room limit itself out of uploading.
    await POST(
      request("?slug=collaborationAssetUploader", {
        "uploadthing-hook": "callback",
      }),
    );
    expect(checks).toEqual([]);
    expect(delegated).toHaveLength(1);
  });

  it("does not count UploadThing's error hook", async () => {
    await POST(
      request("?slug=collaborationAssetUploader", {
        "uploadthing-hook": "error",
      }),
    );
    expect(checks).toEqual([]);
    expect(delegated).toHaveLength(1);
  });

  it("does not count a hook that also carries an actionType", async () => {
    // Belt and braces: the hook header alone disqualifies a request, so a
    // future UploadThing version that starts sending both cannot make a
    // callback consume the user's budget.
    await POST(presign({ "uploadthing-hook": "callback" }));
    expect(checks).toEqual([]);
    expect(delegated).toHaveLength(1);
  });

  it("charges the app's other file routes to one shared per-user upload budget", async () => {
    // Not the collaboration budget: shared-scene, scene-asset and thumbnail
    // uploads share the `upload` budget of the shared-scene limiter.
    for (const slug of [
      "sharedSceneFileUploader",
      "sceneAssetUploader",
      "sceneThumbnailUploader",
    ]) {
      await POST(request(`?actionType=upload&slug=${slug}`));
    }
    expect(checks).toEqual([
      { operation: "upload", identifier: "user-a" },
      { operation: "upload", identifier: "user-a" },
      { operation: "upload", identifier: "user-a" },
    ]);
    expect(delegated).toHaveLength(3);
  });

  it("does not count an unknown slug", async () => {
    await POST(request("?actionType=upload&slug=notARoute"));
    expect(checks).toEqual([]);
    expect(delegated).toHaveLength(1);
  });

  it("does not count an unauthenticated request", async () => {
    // There is no identity to charge. The FileRoute middleware refuses it as
    // `Unauthorized`, which is where authentication belongs.
    session = null;
    await POST(presign());
    expect(checks).toEqual([]);
    expect(delegated).toHaveLength(1);
  });
});

describe("what a refusal looks like", () => {
  it("is a real HTTP 429 with Retry-After and a stable app-owned body", async () => {
    decision = {
      status: "limited",
      reset: 1_770_000_000_000,
      retryAfterMs: 12_400,
    };
    const response = await POST(presign());

    expect(response.status).toBe(429);
    // Rounded up, so the header never authorizes a retry before the window.
    expect(response.headers.get("retry-after")).toBe("13");
    expect(await response.json()).toEqual({
      // The client cannot read this off an error code: UploadThing maps 429 to
      // `INTERNAL_SERVER_ERROR`, so the body has to say what happened itself.
      error: COLLAB_RATE_LIMITED_ERROR,
      operation: "asset-upload",
      reset: 1_770_000_000_000,
      retryAfterMs: 12_400,
    });
    // Nothing reached UploadThing: the refusal happens before the storage
    // object, the room lookup and the commit transaction.
    expect(delegated).toEqual([]);
  });

  it("names the scene upload budget in a scene route's 429", async () => {
    decision = { status: "limited", reset: 1_000, retryAfterMs: 500 };
    const response = await POST(
      request("?actionType=upload&slug=sceneThumbnailUploader"),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: COLLAB_RATE_LIMITED_ERROR,
      operation: "scene-upload",
    });
  });

  it("delegates when the caller is under the limit", async () => {
    const response = await POST(presign());
    expect(response.status).toBe(200);
    expect(delegated).toHaveLength(1);
  });

  it("delegates when Redis is degraded, without ever returning 429", async () => {
    // Fail open: the middleware's room access, role, generation and size checks
    // and the 512-assets-per-generation cap all still run behind this.
    decision = { status: "degraded" };
    const response = await POST(presign());
    expect(response.status).toBe(200);
    expect(delegated).toHaveLength(1);
  });
});
