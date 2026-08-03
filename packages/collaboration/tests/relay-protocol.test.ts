import { describe, expect, it } from "vitest";

import {
  encodeCollaborationMessage,
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_SCENE_MESSAGE_BYTES,
} from "../src/protocol.ts";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  encodeRelayDataFrame,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  MAX_RELAY_DATA_FRAME_BYTES,
  parseRelayClientControl,
  parseRelayServerControl,
  type RelayServerControl,
} from "../src/relay-protocol.ts";
import { CLIENT_A, PEER_A, ROOM_ID, sceneMessage } from "./helpers.ts";

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

  it("derives frame budgets from the protocol message budgets", () => {
    expect(maxRelayDataFrameBytesFor("scene")).toBe(
      MAX_SCENE_MESSAGE_BYTES + 1,
    );
    expect(maxRelayDataFrameBytesFor("presence")).toBe(
      MAX_PRESENCE_MESSAGE_BYTES + 1,
    );
    expect(MAX_RELAY_DATA_FRAME_BYTES).toBe(MAX_SCENE_MESSAGE_BYTES + 1);
  });
});

describe("relay control frames", () => {
  it("round-trips client controls", () => {
    const join = {
      control: "join",
      protocolVersion: 1,
      roomId: ROOM_ID,
      clientId: CLIENT_A,
    } as const;
    expect(parseRelayClientControl(encodeRelayControl(join))).toEqual(join);
    expect(
      parseRelayClientControl(encodeRelayControl({ control: "leave" })),
    ).toEqual({ control: "leave" });
  });

  it("round-trips server controls", () => {
    const joined: RelayServerControl = {
      control: "joined",
      protocolVersion: 1,
      roomId: ROOM_ID,
      peerId: PEER_A,
      roomGeneration: 7,
      peers: [{ peerId: PEER_A, clientId: CLIENT_A }],
    };
    expect(parseRelayServerControl(encodeRelayControl(joined))).toEqual(
      joined,
    );
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
          protocolVersion: 2,
          roomId: ROOM_ID,
          clientId: CLIENT_A,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseRelayClientControl(
        JSON.stringify({
          control: "join",
          protocolVersion: 1,
          roomId: "bad room id!",
          clientId: CLIENT_A,
        }),
      ),
    ).toBeUndefined();
  });
});
