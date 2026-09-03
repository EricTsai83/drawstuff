import { describe, expect, it } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  encodeCollaborationMessage,
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_SCENE_MESSAGE_BYTES,
} from "../src/protocol.ts";
import {
  REALTIME_SEALED_OVERHEAD_BYTES,
  sealedFrameByteLength,
} from "../src/realtime-crypto.ts";
import {
  decodeRelayDataFrame,
  disconnectReasonForCloseCode,
  encodeRelayControl,
  encodeRelayDataFrame,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  MAX_RELAY_DATA_FRAME_BYTES,
  parseRelayClientControl,
  parseRelayServerControl,
  RELAY_CLOSE_CODES,
  unsupportedJoinProtocolVersionOf,
  type RelayServerControl,
} from "../src/relay-protocol.ts";
import { JOIN_TOKEN, PEER_A, ROOM_ID, sceneMessage } from "./helpers.ts";

describe("relay data frames", () => {
  it("round-trips a codec-encoded scene message", () => {
    const encoded = encodeCollaborationMessage(sceneMessage({ sequence: 1 }));
    if (!encoded.ok) throw new Error("expected encodable message");

    const frame = encodeRelayDataFrame("scene", encoded.bytes);
    expect(frame.byteLength).toBe(encoded.bytes.byteLength + 1);

    const decoded = decodeRelayDataFrame(frame);
    expect(decoded?.channel).toBe("scene");
    expect(decoded?.payload).toEqual(encoded.bytes);
  });

  it("distinguishes the presence channel", () => {
    const frame = encodeRelayDataFrame("presence", new Uint8Array([1, 2]));
    expect(decodeRelayDataFrame(frame)?.channel).toBe("presence");
  });

  it("rejects empty frames and unknown channel bytes", () => {
    expect(decodeRelayDataFrame(new Uint8Array())).toBeUndefined();
    expect(decodeRelayDataFrame(new Uint8Array([0x7f, 1]))).toBeUndefined();
  });

  it("leaves the sealing overhead inside every frame budget", () => {
    // The message budgets bound plaintext, so a maximum-size message still has
    // to fit once its IV and GCM tag are added.
    const overhead = REALTIME_SEALED_OVERHEAD_BYTES + 1;
    expect(maxRelayDataFrameBytesFor("scene")).toBe(
      MAX_SCENE_MESSAGE_BYTES + overhead,
    );
    expect(maxRelayDataFrameBytesFor("presence")).toBe(
      MAX_PRESENCE_MESSAGE_BYTES + overhead,
    );
    expect(MAX_RELAY_DATA_FRAME_BYTES).toBe(MAX_SCENE_MESSAGE_BYTES + overhead);
    expect(
      encodeRelayDataFrame(
        "presence",
        new Uint8Array(sealedFrameByteLength(MAX_PRESENCE_MESSAGE_BYTES)),
      ).byteLength,
    ).toBe(maxRelayDataFrameBytesFor("presence"));
  });
});

describe("relay control frames", () => {
  it("round-trips client controls", () => {
    const join = {
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      token: JOIN_TOKEN,
    } as const;
    expect(parseRelayClientControl(encodeRelayControl(join))).toEqual(join);
    // A join without a token is not a join: the relay has no anonymous path.
    const tokenless = { ...join, token: undefined };
    expect(parseRelayClientControl(JSON.stringify(tokenless))).toBeUndefined();
    expect(
      parseRelayClientControl(encodeRelayControl({ control: "leave" })),
    ).toEqual({ control: "leave" });
  });

  it("round-trips server controls", () => {
    const joined: RelayServerControl = {
      control: "joined",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      peerId: PEER_A,
      roomGeneration: 7,
      role: "viewer",
      peers: [{ peerId: PEER_A, role: "viewer" }],
    };
    expect(parseRelayServerControl(encodeRelayControl(joined))).toEqual(joined);
  });

  it("rejects malformed, mixed-direction, and oversize controls", () => {
    expect(parseRelayClientControl("not json")).toBeUndefined();
    expect(parseRelayClientControl('{"control":"unknown"}')).toBeUndefined();
    // A server-only control is not a valid client control and vice versa.
    expect(
      parseRelayClientControl(
        encodeRelayControl({ control: "peers", peers: [] }),
      ),
    ).toBeUndefined();
    expect(
      parseRelayServerControl(encodeRelayControl({ control: "leave" })),
    ).toBeUndefined();
    expect(
      parseRelayClientControl(
        `{"control":"join","pad":"${"x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES)}"}`,
      ),
    ).toBeUndefined();
  });

  it("rejects a join with an invalid protocol version or ids", () => {
    expect(
      parseRelayClientControl(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION - 1,
          roomId: ROOM_ID,
          token: JOIN_TOKEN,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseRelayClientControl(
        JSON.stringify({
          control: "join",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          roomId: "bad room id!",
          token: JOIN_TOKEN,
        }),
      ),
    ).toBeUndefined();
  });
});

describe("protocol version bumps", () => {
  const joinWithVersion = (protocolVersion: unknown): string =>
    JSON.stringify({
      control: "join",
      protocolVersion,
      roomId: ROOM_ID,
      token: JOIN_TOKEN,
    });

  it("detects a join whose declared version predates this build's", () => {
    expect(
      unsupportedJoinProtocolVersionOf(
        joinWithVersion(COLLABORATION_PROTOCOL_VERSION - 1),
      ),
    ).toBe(COLLABORATION_PROTOCOL_VERSION - 1);
  });

  it("detects a join whose declared version is ahead of this build's", () => {
    // The web app deployed a bump before the relay: an outdated *relay*, not
    // a broken client. Same skew code, so the client waits for the relay to
    // catch up instead of ending terminally on a generic violation.
    expect(
      unsupportedJoinProtocolVersionOf(
        joinWithVersion(COLLABORATION_PROTOCOL_VERSION + 1),
      ),
    ).toBe(COLLABORATION_PROTOCOL_VERSION + 1);
  });

  it("does not flag the current version, or non-join garbage", () => {
    // The current version is not a mismatch even when the join is otherwise
    // malformed: that stays a protocol violation.
    expect(
      unsupportedJoinProtocolVersionOf(
        joinWithVersion(COLLABORATION_PROTOCOL_VERSION),
      ),
    ).toBeUndefined();
    expect(unsupportedJoinProtocolVersionOf("not json")).toBeUndefined();
    expect(
      unsupportedJoinProtocolVersionOf('{"control":"leave"}'),
    ).toBeUndefined();
    expect(
      unsupportedJoinProtocolVersionOf(joinWithVersion("2")),
    ).toBeUndefined();
    expect(
      unsupportedJoinProtocolVersionOf(
        `{"control":"join","pad":"${"x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES)}"}`,
      ),
    ).toBeUndefined();
  });

  it("maps the unsupported-version close code to its own reason", () => {
    expect(
      disconnectReasonForCloseCode(
        RELAY_CLOSE_CODES.unsupportedProtocolVersion,
      ),
    ).toBe("unsupported-protocol-version");
    // Still distinct from a wire-contract violation.
    expect(
      disconnectReasonForCloseCode(RELAY_CLOSE_CODES.protocolViolation),
    ).toBe("protocol");
  });
});
