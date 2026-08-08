import { afterEach, describe, expect, it } from "vitest";

import {
  decodeCollaborationMessage,
  roomIdSchema,
  type MessageChannel,
  type PeerId,
} from "@drawstuff/collaboration/protocol";
import {
  createRealtimeCryptoCodec,
  generateRoomKey,
  REALTIME_CRYPTO_VERSION,
  MIN_REALTIME_SEALED_FRAME_BYTES,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
import { decodeRelayDataFrame } from "@drawstuff/collaboration/relay-protocol";

import {
  createInMemoryRoomFanout,
  type FanoutSubscriber,
  type RoomFanout,
} from "../src/fanout.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { createTestLogger } from "./support/observability.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./support/room-tokens.ts";
import {
  createTestClient,
  TEST_ROOM_KEY,
  waitUntil,
  type TestClient,
} from "./support/test-client.ts";

/**
 * Plan 14 outcome check: the relay is a router for ciphertext.
 *
 * These tests do not inspect client state to make their point — they tap the
 * fanout, the exact boundary every routed frame crosses, and assert against the
 * bytes the relay itself handles.
 */

const ROOM_ID = roomIdSchema.parse("room-e2ee");
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

const SECRET_LABEL = "top-secret-drawing-label";

type RoutedFrame = {
  channel: MessageChannel;
  frame: Uint8Array;
  senderPeerId: PeerId;
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/** A fanout that keeps a copy of every frame the relay routes. */
function recordingFanout(): { fanout: RoomFanout; routed: RoutedFrame[] } {
  const inner = createInMemoryRoomFanout();
  const routed: RoutedFrame[] = [];
  return {
    routed,
    fanout: {
      ...inner,
      publish(channel, senderPeerId, messageChannel, frame) {
        routed.push({
          channel: messageChannel,
          frame: Uint8Array.from(frame),
          senderPeerId,
        });
        return inner.publish(channel, senderPeerId, messageChannel, frame);
      },
    },
  };
}

/**
 * A compromised relay: it delivers each frame, then a verbatim copy of it
 * (replay) and a copy with a flipped tag bit (tamper).
 */
function hostileFanout(): RoomFanout {
  const inner = createInMemoryRoomFanout();
  const subscribers = new Map<PeerId, FanoutSubscriber>();
  return {
    ...inner,
    join(member) {
      subscribers.set(member.peerId, member.subscriber);
      return inner.join(member);
    },
    leave(channel, peerId) {
      subscribers.delete(peerId);
      inner.leave(channel, peerId);
    },
    publish(channel, senderPeerId, messageChannel, frame) {
      const routed = inner.publish(
        channel,
        senderPeerId,
        messageChannel,
        frame,
      );
      const tampered = Uint8Array.from(frame);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
      for (const [peerId, subscriber] of subscribers) {
        if (peerId === senderPeerId) continue;
        subscriber.deliverData(messageChannel, frame, senderPeerId);
        subscriber.deliverData(messageChannel, tampered, senderPeerId);
      }
      return routed;
    },
  };
}

async function startServer(fanout: RoomFanout): Promise<RelayServer> {
  const server = await createRelayServer({
    joinTokenSecret: TEST_ROOM_TOKEN_SECRET,
    fanout,
    logger: createTestLogger().logger,
  });
  cleanups.push(() => server.close());
  return server;
}

async function member(
  url: string,
  clientName: string,
  nonceSeed: number,
  overrides: { roomKey?: RoomKey } = {},
): Promise<TestClient> {
  const client = await createTestClient({
    url,
    roomId: ROOM_ID,
    clientName,
    nonceSeed,
    ...overrides,
  });
  cleanups.push(() => client.close());
  return client;
}

/** Every byte the relay routed, decoded the way a log line would decode it. */
const routedText = (routed: readonly RoutedFrame[]): string =>
  new TextDecoder("utf-8").decode(
    Uint8Array.from(routed.flatMap(({ frame }) => [...frame])),
  );

/** Lets already-delivered frames finish their asynchronous open step. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 250));

describe("relay payload confidentiality", () => {
  it("routes only ciphertext: no element, username, or cursor payload is readable", async () => {
    const { fanout, routed } = recordingFanout();
    const server = await startServer(fanout);
    const a = await member(server.url, CLIENT_A, 1);
    const b = await member(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();

    a.upsertElement("el-secret", SECRET_LABEL);
    a.sendPresence(1_337, 4_242);
    await waitUntil(
      () =>
        b.elementIds().includes("el-secret") && b.presenceReceived().length > 0,
      "the room to exchange a scene delta and a presence sample",
    );

    // The room worked: B holds A's element and A's cursor.
    expect(b.presenceReceived()[0]?.payload.pointer).toEqual({
      x: 1_337,
      y: 4_242,
      tool: "pointer",
    });
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.some(({ channel }) => channel === "presence")).toBe(true);

    // Nothing the relay routed contains anything a reader could use: not the
    // element body, not the username, not the pointer coordinates, not even the
    // message type — and never the room key.
    const wire = routedText(routed);
    for (const secret of [
      SECRET_LABEL,
      "el-secret",
      "scene-update",
      "presence",
      "pointer",
      "versionNonce",
      "username",
      // Long enough that a random ciphertext match is not a realistic flake.
      '"x":1337',
      '"y":4242',
      TEST_ROOM_KEY,
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("carries no sender identity in the frame at all", async () => {
    const { fanout, routed } = recordingFanout();
    const server = await startServer(fanout);
    const a = await member(server.url, CLIENT_A, 1);
    const b = await member(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-visible", SECRET_LABEL);
    await waitUntil(
      () => b.elementIds().includes("el-visible"),
      "the delta to reach the other member",
    );
    expect(routed.length).toBeGreaterThan(0);

    // The sealed frame is a version byte, a random IV, and ciphertext. Nothing
    // identifies the sender, so the bytes on their own do not say who is in the
    // room — the relay knows, because it routes per socket, but a captured frame
    // does not. Asserted against the specific identifiers this room uses rather
    // than by scanning for printable runs: the IV is random, so a run scan would
    // fail every so often on its own.
    for (const { frame, senderPeerId } of routed) {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("relay routed an unaddressable frame");
      expect(dataFrame.payload[0]).toBe(REALTIME_CRYPTO_VERSION);
      expect(dataFrame.payload.byteLength).toBeGreaterThanOrEqual(
        MIN_REALTIME_SEALED_FRAME_BYTES,
      );

      const bytes = new TextDecoder("utf-8").decode(dataFrame.payload);
      for (const identifier of [
        ROOM_ID,
        CLIENT_A,
        CLIENT_B,
        senderPeerId,
        "el-visible",
        SECRET_LABEL,
      ]) {
        expect(bytes).not.toContain(identifier);
      }
    }
  });

  it("cannot parse a routed frame with the protocol codec it already imports", async () => {
    const { fanout, routed } = recordingFanout();
    const server = await startServer(fanout);
    const a = await member(server.url, CLIENT_A, 1);
    const b = await member(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-opaque", SECRET_LABEL);
    a.sendPresence(7, 8);
    await waitUntil(
      () =>
        b.elementIds().includes("el-opaque") && b.presenceReceived().length > 0,
      "the room to exchange both channels",
    );

    expect(routed.length).toBeGreaterThan(0);
    for (const { channel, frame } of routed) {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("relay routed an unaddressable frame");
      // The relay reads the channel byte, and that is all it can read.
      expect(dataFrame.channel).toBe(channel);
      expect(dataFrame.payload[0]).toBe(REALTIME_CRYPTO_VERSION);
      expect(dataFrame.payload.byteLength).toBeGreaterThanOrEqual(
        MIN_REALTIME_SEALED_FRAME_BYTES,
      );
      expect(decodeCollaborationMessage(dataFrame.payload, channel).ok).toBe(
        false,
      );
    }
  });

  it("gives nothing away to a relay that also holds the room's tokens", async () => {
    const { fanout, routed } = recordingFanout();
    const server = await startServer(fanout);
    const a = await member(server.url, CLIENT_A, 1);
    const b = await member(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    a.upsertElement("el-sealed", SECRET_LABEL);
    await waitUntil(
      () => b.elementIds().includes("el-sealed"),
      "the delta to reach the other member",
    );

    // A relay-side attacker knows the room id and the authorization generation
    // — both are claims in the tokens it verifies — and still cannot open a
    // frame, because the room key is the one input the app never receives.
    const relaySideCodec = await createRealtimeCryptoCodec({
      roomKey: generateRoomKey(),
      roomId: ROOM_ID,
      authGeneration: 1,
    });
    expect(routed.length).toBeGreaterThan(0);
    for (const { channel, frame } of routed) {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("relay routed an unaddressable frame");
      expect(await relaySideCodec.open(dataFrame.payload, channel)).toEqual({
        ok: false,
        error: { code: "authentication-failed" },
      });
    }
  });

  it("keeps an authorized member with the wrong room key out of the scene", async () => {
    const { fanout, routed } = recordingFanout();
    const server = await startServer(fanout);
    const a = await member(server.url, CLIENT_A, 1);
    // Authorized by the app (its join token verifies) but holding a different
    // key: authorization and confidentiality are separate gates.
    const intruder = await member(server.url, CLIENT_B, 2, {
      roomKey: generateRoomKey(),
    });
    await a.connect();
    await intruder.connect();
    await waitUntil(
      () => a.peers().length === 2 && intruder.peers().length === 2,
      "the intruder to become a room member",
    );

    a.upsertElement("el-private", SECRET_LABEL);
    intruder.upsertElement("el-injected", "from-intruder");
    // Wait for real routing in both directions rather than for a timeout: the
    // point is that delivered frames were dropped, not that none arrived.
    await waitUntil(
      () => new Set(routed.map(({ senderPeerId }) => senderPeerId)).size === 2,
      "the relay to route frames from both members",
    );
    await settle();

    expect(a.elementIds()).toEqual(["el-private"]);
    expect(intruder.elementIds()).toEqual(["el-injected"]);
    expect(a.presenceReceived()).toHaveLength(0);
    // Neither side crashed or lost its connection over the mismatch.
    expect(a.connectionState().status).toBe("connected");
    expect(intruder.connectionState().status).toBe("connected");
  });

  it("survives a relay that replays and tampers with every frame", async () => {
    const server = await startServer(hostileFanout());
    const a = await member(server.url, CLIENT_A, 1);
    const b = await member(server.url, CLIENT_B, 2);
    await a.connect();
    await b.connect();
    await waitUntil(
      () => a.peers().length === 2 && b.peers().length === 2,
      "both members to join",
    );

    a.upsertElement("el-durable", SECRET_LABEL);
    b.upsertElement("el-other", "from-b");
    await waitUntil(
      () =>
        a.digest() === b.digest() &&
        a.elementIds().length === 2 &&
        a.elementIds().includes("el-durable"),
      "the room to converge despite replayed and tampered frames",
    );
    await settle();

    // Duplicates were refused by the nonce replay cache, tampered copies by
    // authentication, and both sessions stayed up.
    expect(a.elementIds()).toEqual(["el-durable", "el-other"]);
    expect(b.elementIds()).toEqual(["el-durable", "el-other"]);
    expect(a.connectionState().status).toBe("connected");
    expect(b.connectionState().status).toBe("connected");
  });
});
