/**
 * Shared `ws` plumbing for the operator scripts (smoke, conformance:remote,
 * loadtest): one socket adapter onto the conformance event queue and one
 * synthetic join-token issuer, so every script reads the wire and signs
 * tokens through a single implementation.
 */

import { WebSocket } from "ws";

import { createConformanceConnection } from "@drawstuff/collaboration/protocol-conformance";
import {
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signJoinToken,
} from "@drawstuff/collaboration/room-token";

/** Must be on the deployed Worker's COLLAB_ALLOWED_ORIGINS allowlist. */
export const SMOKE_ORIGIN =
  process.env.COLLAB_SMOKE_ORIGIN ?? "http://localhost:3000";

export function roomSocketUrl(target, roomId, authGeneration) {
  return `${target.replace(/^http/, "ws")}/v1/rooms/${roomId}/generations/${authGeneration}/socket`;
}

/** Bytes of one `ws` message event, whichever shape `ws` delivered. */
export function messageBytes(data) {
  return data instanceof ArrayBuffer
    ? Buffer.from(data)
    : Buffer.concat([data].flat());
}

/**
 * One raw client: a `ws` socket (which, unlike the WHATWG client, can present
 * the allowlisted Origin) feeding the shared conformance event queue. The raw
 * socket stays exposed for checks that must observe an exact frame — the
 * shared queue filters keepalive acknowledgments by contract.
 */
export function openConformanceSocket({ url, closeReason }) {
  const socket = new WebSocket(url, { headers: { Origin: SMOKE_ORIGIN } });
  socket.binaryType = "arraybuffer";
  const { connection, push } = createConformanceConnection({
    send: (data) => socket.send(data),
    close: () => socket.close(1000, closeReason),
  });
  socket.on("message", (data, isBinary) => {
    const bytes = messageBytes(data);
    if (isBinary) push({ kind: "binary", bytes: new Uint8Array(bytes) });
    else push({ kind: "text", text: bytes.toString("utf8") });
  });
  socket.on("close", (code, reason) =>
    push({ kind: "close", code, reason: reason.toString("utf8") }),
  );
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`upgrade refused with status ${response.statusCode}`)),
    );
  });
  return { socket, connection, opened };
}

/** A one-minute join token for a synthetic room that lives one hour. */
export function issueSyntheticJoinToken({
  roomId,
  secret,
  subject,
  role = "editor",
  authGeneration = 1,
}) {
  const now = Math.floor(Date.now() / 1000);
  return signJoinToken(
    {
      v: ROOM_TOKEN_VERSION,
      jti: createRoomTokenId(),
      iat: now,
      exp: now + 60,
      aud: ROOM_TOKEN_AUDIENCES.join,
      rid: roomId,
      gen: authGeneration,
      sub: subject,
      role,
      arev: 1,
      rexp: now + 3_600,
    },
    secret,
  );
}
