import type { IncomingMessage, ServerResponse } from "node:http";

import { RELAY_METRICS_CONTENT_TYPE, type RelayMetrics } from "./metrics.ts";

/**
 * Monitoring endpoints (Plan 24), served on the relay's own HTTP listener
 * alongside the control endpoint.
 *
 * Both are unauthenticated on purpose: a metrics scrape and a health probe come
 * from the same host as the process, before any collaboration credential exists,
 * and requiring a token would mean the relay hands out one more secret to
 * something that is not a room member. What makes that safe is what the responses
 * contain — see `./metrics.ts` for why no room id, subject or payload can reach
 * the exposition, and note that `/healthz` answers with a status word and nothing
 * else. Keeping the port off the public internet is the deployment envelope's job
 * (Plan 25), not an authorization decision here.
 *
 * The two endpoints answer different questions and must not be merged.
 * `/metrics` describes capacity; `/healthz` states only whether this process
 * should still receive traffic. A load balancer that had to parse capacity
 * numbers to decide would be making a policy decision the relay already made.
 */
export const RELAY_METRICS_PATH = "/metrics";
export const RELAY_HEALTH_PATH = "/healthz";

const respondText = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void => {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body, "utf8"),
    // A scrape and a probe are point-in-time reads; a cached one is a lie.
    "cache-control": "no-store",
  });
  response.end(body);
};

/**
 * Returns true when the request was a monitoring request and has been answered,
 * so the caller can fall through to the control endpoint otherwise.
 */
export function createRelayMonitoringRequestHandler(options: {
  metrics: RelayMetrics;
  /**
   * True once the process has begun draining. Draining must read as unhealthy:
   * that is the signal a rolling restart hands over on (Plan 25).
   */
  isDraining: () => boolean;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  const { metrics, isDraining } = options;

  return (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== RELAY_METRICS_PATH && path !== RELAY_HEALTH_PATH) return false;

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      respondText(
        response,
        405,
        "application/json",
        JSON.stringify({ error: "method-not-allowed" }),
      );
      return true;
    }

    if (path === RELAY_HEALTH_PATH) {
      const draining = isDraining();
      respondText(
        response,
        draining ? 503 : 200,
        "application/json",
        // Status only. Capacity belongs to `/metrics`: a probe that reported
        // "full" would invite a load balancer to treat a healthy-but-busy relay
        // as failed, which is the opposite of what the capacity close codes do.
        `${JSON.stringify({ status: draining ? "draining" : "ok" })}\n`,
      );
      return true;
    }

    respondText(response, 200, RELAY_METRICS_CONTENT_TYPE, metrics.render());
    return true;
  };
}
