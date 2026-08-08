import { type NextRequest } from "next/server";
import { createRouteHandler } from "uploadthing/next";

import { getServerSession } from "@/lib/auth/server";
import {
  COLLAB_RATE_LIMITED_ERROR,
  type CollaborationRateLimitErrorBody,
} from "@/lib/collab/rate-limit";
import { checkCollaborationRateLimit } from "@/server/rate-limit/collaboration";

import { uploadRouter } from "./core";

const { GET, POST: handleUploadThingRequest } = createRouteHandler({
  router: uploadRouter,

  // Apply an (optional) custom config:
  // config: { ... },
});

/**
 * Rate limits collaboration asset uploads at the presign request.
 *
 * The limit cannot live in the FileRoute middleware: UploadThing 7.7.4 has no
 * `TOO_MANY_REQUESTS` error code, so anything thrown from there becomes a 400
 * or a 500 — a client would read a rate limit as a permanent refusal, which is
 * the opposite of what it is. So the refusal is issued here, where a real HTTP
 * 429 with a `Retry-After` header and an app-owned JSON body is possible.
 *
 * The presign POST is also the right request to count. It is the one that
 * precedes the expensive work — the storage object, the room lookup, the
 * commit transaction — so a refusal costs nothing, and it is exactly one per
 * upload attempt. The callback and error hooks arrive on the same path with
 * the same slug and must not be counted: they are UploadThing's own
 * server-to-server traffic, not the user's, and counting them would let a busy
 * room limit itself.
 */
const COLLABORATION_UPLOAD_SLUG = "collaborationAssetUploader";

/**
 * True only for the client's authenticated presign request.
 *
 * `actionType=upload` identifies the presign; the `uploadthing-hook` header
 * identifies a callback or error hook, which never carries an `actionType`.
 * Requiring the first and rejecting the second means neither hook can consume
 * a caller's budget even if UploadThing later adds a query parameter.
 */
function isCollaborationPresignRequest(request: NextRequest): boolean {
  const params = new URL(request.url).searchParams;
  return (
    params.get("slug") === COLLABORATION_UPLOAD_SLUG &&
    params.get("actionType") === "upload" &&
    request.headers.get("uploadthing-hook") === null
  );
}

function rateLimitedResponse(metadata: {
  reset: number;
  retryAfterMs: number;
}): Response {
  const body: CollaborationRateLimitErrorBody = {
    error: COLLAB_RATE_LIMITED_ERROR,
    operation: "asset-upload",
    reset: metadata.reset,
    retryAfterMs: metadata.retryAfterMs,
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json",
      // Seconds, rounded up: a header that rounds down would authorize a
      // retry the server has not yet reset for.
      "retry-after": String(Math.ceil(metadata.retryAfterMs / 1000)),
      "cache-control": "no-store",
    },
  });
}

async function POST(request: NextRequest): Promise<Response> {
  if (!isCollaborationPresignRequest(request)) {
    return handleUploadThingRequest(request);
  }
  const session = await getServerSession();
  // Authentication is the FileRoute middleware's job and stays there; this only
  // decides whose budget to spend. An unauthenticated request has no identity
  // to charge, so it is passed through to be refused as `Unauthorized` — a
  // caller must not be able to spend a budget it has not authenticated into,
  // in either direction.
  if (!session) return handleUploadThingRequest(request);

  const decision = await checkCollaborationRateLimit({
    operation: "asset-upload",
    identifier: session.user.id,
  });
  // `degraded` delegates exactly like `allowed`: the middleware's room access,
  // role, generation and size checks and the 512-assets-per-generation cap all
  // still run, so a Redis outage costs the abuse ceiling and nothing else.
  if (decision.status !== "limited") return handleUploadThingRequest(request);
  return rateLimitedResponse(decision);
}

export { GET, POST };
