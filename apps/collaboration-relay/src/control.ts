import type { IncomingMessage, ServerResponse } from "node:http";

import {
  RELAY_CONTROL_PATH,
  relayControlRequestSchema,
  type RelayControlResponse,
} from "@drawstuff/collaboration/relay-control";
import { roomChannelKey } from "@drawstuff/collaboration/room-auth";
import { verifyRoomControlToken } from "@drawstuff/collaboration/room-token";

import type { RelayLogger } from "./logger.ts";
import type { RelayMetrics } from "./metrics.ts";
import type { RelaySessionRegistry } from "./sessions.ts";

/**
 * Server-to-server lifecycle endpoint.
 *
 * Authorization revocation must take effect on connections that already
 * joined, and the relay deliberately keeps no membership database to consult.
 * So the app pushes the change: it signs a short-lived, single-action control
 * token and the relay closes the matching sockets. Only these two actions
 * exist, both idempotent, both scoped to one room generation.
 *
 * The endpoint is authenticated by the token alone (no session, no cookie, no
 * long-lived admin credential) and never accepts room state, scene data, or
 * key material.
 *
 * Path and body/response shapes are the shared contract in
 * `@drawstuff/collaboration/relay-control`; re-exported for the server wiring.
 */
export { RELAY_CONTROL_PATH };

/** Control bodies carry one token; anything larger is refused unread. */
const MAX_CONTROL_BODY_BYTES = 4_096;

const respond = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  options: { closeConnection?: boolean } = {},
): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload, "utf8"),
    ...(options.closeConnection ? { connection: "close" } : {}),
  });
  response.end(payload);
};

/**
 * Reads at most `MAX_CONTROL_BODY_BYTES`. On overflow it stops consuming and
 * reports the failure instead of destroying the request, so the caller can
 * still answer 413 before the connection goes away.
 */
const readBody = (
  request: IncomingMessage,
): Promise<{ ok: true; raw: string } | { ok: false; status: number }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (
      result: { ok: true; raw: string } | { ok: false; status: number },
    ): void => {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      resolve(result);
    };
    function onData(chunk: Buffer): void {
      size += chunk.byteLength;
      if (size > MAX_CONTROL_BODY_BYTES) {
        request.pause();
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    }
    request.on("data", onData);
    request.once("end", () =>
      finish({ ok: true, raw: Buffer.concat(chunks).toString("utf8") }),
    );
    request.once("error", () => finish({ ok: false, status: 400 }));
  });

export function createRelayControlRequestHandler(options: {
  sessions: RelaySessionRegistry;
  /** Same secret the app signs room tokens with. */
  joinTokenSecret: string;
  metrics: RelayMetrics;
  logger: RelayLogger;
  now?: () => number;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const {
    sessions,
    joinTokenSecret,
    metrics,
    logger,
    now = Date.now,
  } = options;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== RELAY_CONTROL_PATH) {
      metrics.controlRequest("rejected");
      respond(response, 404, { error: "not-found" });
      return;
    }
    if (request.method !== "POST") {
      metrics.controlRequest("rejected");
      response.setHeader("allow", "POST");
      respond(response, 405, { error: "method-not-allowed" });
      return;
    }

    const body = await readBody(request);
    if (!body.ok) {
      metrics.controlRequest("rejected");
      // The rest of the body is never read, so the connection cannot be
      // reused: answer and close it.
      respond(
        response,
        body.status,
        { error: body.status === 413 ? "payload-too-large" : "malformed-body" },
        { closeConnection: true },
      );
      response.once("finish", () => request.destroy());
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body.raw) as unknown;
    } catch {
      metrics.controlRequest("rejected");
      respond(response, 400, { error: "malformed-body" });
      return;
    }
    const parsedBody = relayControlRequestSchema.safeParse(parsedJson);
    if (!parsedBody.success) {
      metrics.controlRequest("rejected");
      respond(response, 400, { error: "malformed-body" });
      return;
    }

    const verified = verifyRoomControlToken({
      token: parsedBody.data.token,
      secret: joinTokenSecret,
      nowSeconds: Math.floor(now() / 1000),
    });
    if (!verified.ok) {
      metrics.controlRequest("unauthorized");
      logger.warn("relay.control", {
        controlOutcome: "unauthorized",
        tokenFailure: verified.reason,
      });
      respond(response, 401, { error: "unauthorized" });
      return;
    }

    const claims = verified.claims;
    const channel = roomChannelKey(claims.rid, claims.gen);
    // The revision this change produced is the cutoff: every join token issued
    // below it is refused from now on, and a replay of this control token
    // cannot reach a session that a later revision authorized.
    const cutoff = {
      revision: claims.arev,
      nowSeconds: Math.floor(now() / 1000),
    };
    const closed =
      claims.action === "end-room"
        ? sessions.endChannel(channel, cutoff)
        : sessions.revokeMember(channel, claims.sub, cutoff);
    metrics.controlRequest("applied");
    // `sub` is pseudonymized here for the same reason as on the join path: a
    // revocation names a user, and naming them in a log is what §5 forbids.
    logger.info("relay.control", {
      controlAction: claims.action,
      controlOutcome: "applied",
      roomId: claims.rid,
      authGeneration: claims.gen,
      subject:
        claims.action === "revoke-member"
          ? logger.pseudonym(claims.sub)
          : undefined,
      closedSessions: closed,
    });
    const controlResponse: RelayControlResponse = {
      action: claims.action,
      closed,
    };
    respond(response, 200, controlResponse);
  };

  return (request, response) => {
    void handle(request, response).catch(() => {
      metrics.controlRequest("failed");
      logger.error("relay.control", { controlOutcome: "failed" });
      if (!response.headersSent) {
        respond(response, 500, { error: "control-failed" });
        return;
      }
      response.end();
    });
  };
}
