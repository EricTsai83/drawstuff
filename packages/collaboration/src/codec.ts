import { z } from "zod";

import {
  COLLABORATION_PROTOCOL_VERSION,
  collaborationMessageSchema,
  maxEncodedBytesFor,
  maxMessageBytesFor,
  messageChannelOf,
  type CollaborationMessage,
  type MessageChannel,
} from "./messages.ts";

export type { MessageChannel } from "./messages.ts";

export type CollaborationProtocolError =
  | { code: "oversize-payload"; byteLength: number; maxByteLength: number }
  | { code: "malformed-payload"; detail: string }
  | { code: "unknown-protocol-version"; receivedVersion: number | undefined };

export type EncodeMessageResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: CollaborationProtocolError };

export type DecodeMessageResult =
  | { ok: true; message: CollaborationMessage }
  | { ok: false; error: CollaborationProtocolError };

const textEncoder = new TextEncoder();
// Fatal so malformed UTF-8 is rejected instead of silently repaired into a
// different (possibly valid) message via U+FFFD replacement.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeCollaborationMessage(
  message: CollaborationMessage,
): EncodeMessageResult {
  const parsed = collaborationMessageSchema.safeParse(message);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-payload",
        detail: z.prettifyError(parsed.error),
      },
    };
  }

  let bytes: Uint8Array;
  try {
    // Engine-owned element fields pass schema validation unprojected, so a
    // non-serializable value (bigint, circular reference) surfaces here.
    bytes = textEncoder.encode(JSON.stringify(parsed.data));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-payload",
        detail:
          error instanceof Error ? error.message : "Unserializable message",
      },
    };
  }

  const maxByteLength = maxEncodedBytesFor(parsed.data.type);
  if (bytes.byteLength > maxByteLength) {
    return {
      ok: false,
      error: {
        code: "oversize-payload",
        byteLength: bytes.byteLength,
        maxByteLength,
      },
    };
  }

  return { ok: true, bytes };
}

export function decodeCollaborationMessage(
  bytes: Uint8Array,
  channel: MessageChannel,
): DecodeMessageResult {
  // The channel determines the byte budget, so raw bytes are bounded before
  // any JSON parsing — oversize input is never decoded, whatever it contains.
  const maxByteLength = maxMessageBytesFor(channel);
  if (bytes.byteLength > maxByteLength) {
    return {
      ok: false,
      error: {
        code: "oversize-payload",
        byteLength: bytes.byteLength,
        maxByteLength,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-payload",
        detail: error instanceof Error ? error.message : "Invalid JSON",
      },
    };
  }

  const receivedVersion =
    typeof raw === "object" && raw !== null && "protocolVersion" in raw
      ? raw.protocolVersion
      : undefined;
  if (receivedVersion !== COLLABORATION_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: "unknown-protocol-version",
        receivedVersion:
          typeof receivedVersion === "number" ? receivedVersion : undefined,
      },
    };
  }

  const parsed = collaborationMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-payload",
        detail: z.prettifyError(parsed.error),
      },
    };
  }

  if (messageChannelOf(parsed.data.type) !== channel) {
    return {
      ok: false,
      error: {
        code: "malformed-payload",
        detail: `"${parsed.data.type}" message received on the ${channel} channel`,
      },
    };
  }

  return { ok: true, message: parsed.data };
}
