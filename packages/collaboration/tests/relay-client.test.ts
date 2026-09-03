import { describe, expect, it, vi } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeCollaborationMessage,
  encodeCollaborationMessage,
  type CollaborationMessage,
} from "../src/protocol.ts";
import {
  generateRoomKey,
  REALTIME_CRYPTO_VERSION,
  sealedFrameByteLength,
  type RealtimeCryptoCodec,
} from "../src/realtime-crypto.ts";
import {
  createRelayWebSocketTransport,
  INBOUND_QUEUE_ENTRY_COST_BYTES,
  REALTIME_UNREADABLE_FRAME_THRESHOLD,
  type RelaySocketLike,
} from "../src/relay-client.ts";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayClientControl,
  RELAY_CLOSE_CODES,
  type RelayServerControl,
} from "../src/relay-protocol.ts";
import type {
  ConnectionState,
  DisconnectReason,
  RoomPeer,
} from "../src/transport.ts";
import {
  connectedState,
  element,
  JOIN_TOKEN,
  PEER_A,
  PEER_B,
  presenceFromSession,
  presenceMessage,
  roomCodec,
  ROOM_ID,
  sceneFromSession,
  sceneMessage,
} from "./helpers.ts";
import type { MessageChannel } from "../src/codec.ts";

class FakeSocket implements RelaySocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receiveControl(control: RelayServerControl): void {
    this.onmessage?.({ data: encodeRelayControl(control) });
  }

  receiveFrame(frame: Uint8Array): void {
    // Delivered as ArrayBuffer, matching binaryType = "arraybuffer".
    this.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    });
  }

  serverClose(code?: number): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? {} : { code });
  }
}

const joinedNotice = (
  overrides: Partial<Extract<RelayServerControl, { control: "joined" }>> = {},
): RelayServerControl => ({
  control: "joined",
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  roomId: ROOM_ID,
  peerId: PEER_A,
  roomGeneration: 3,
  role: "editor",
  peers: [{ peerId: PEER_A, role: "editor" }],
  ...overrides,
});

/** Wire size of one message once sealed and wrapped in a relay data frame. */
const wireSizeOf = (message: CollaborationMessage): number => {
  const encoded = encodeCollaborationMessage(message);
  if (!encoded.ok) throw new Error("expected encodable message");
  return sealedFrameByteLength(encoded.bytes.byteLength) + 1;
};

/** Seals a message the way a remote peer would, for inbound delivery tests. */
const remoteFrame = async (
  peerCodec: RealtimeCryptoCodec,
  message: CollaborationMessage,
  channel: MessageChannel,
): Promise<Uint8Array> => {
  const encoded = encodeCollaborationMessage(message);
  if (!encoded.ok) throw new Error("expected encodable message");
  const result = await peerCodec.seal(encoded.bytes, channel);
  if (!result.ok)
    throw new Error(`expected a sealed frame: ${result.error.code}`);
  return encodeRelayDataFrame(channel, result.frame);
};

async function setup(
  options: {
    maxBufferedBytes?: number;
    maxInboundPendingBytes?: number;
    maxSealedMessages?: number;
    wrapCrypto?: (codec: RealtimeCryptoCodec) => RealtimeCryptoCodec;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const baseCodec = await roomCodec({
    maxSealedMessages: options.maxSealedMessages,
  });
  const cryptoCodec = options.wrapCrypto?.(baseCodec) ?? baseCodec;
  const transport = createRelayWebSocketTransport({
    url: "ws://relay.test",
    crypto: cryptoCodec,
    maxBufferedBytes: options.maxBufferedBytes,
    maxInboundPendingBytes: options.maxInboundPendingBytes,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const states: ConnectionState[] = [];
  const messages: CollaborationMessage[] = [];
  const peerUpdates: (readonly RoomPeer[])[] = [];
  const unreadableVerdicts = { count: 0 };
  transport.subscribe({
    onConnectionStateChange: (state) => states.push(state),
    onMessage: (message) => messages.push(message),
    onRoomPeersChange: (peers) => peerUpdates.push(peers),
    onRoomUnreadable: () => {
      unreadableVerdicts.count += 1;
    },
  });
  const connectAndJoin = (joinOptions?: {
    joined?: Partial<Extract<RelayServerControl, { control: "joined" }>>;
  }): FakeSocket => {
    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket created");
    socket.open();
    socket.receiveControl(joinedNotice(joinOptions?.joined));
    return socket;
  };
  return {
    transport,
    cryptoCodec,
    sockets,
    states,
    messages,
    peerUpdates,
    unreadableVerdicts,
    connectAndJoin,
  };
}

describe("createRelayWebSocketTransport", () => {
  it("connects, joins, and adopts the relay-assigned session identity", async () => {
    const { transport, states, peerUpdates, connectAndJoin } = await setup();
    const socket = connectAndJoin();

    expect(socket.binaryType).toBe("arraybuffer");
    const join = parseRelayClientControl(socket.sentText[0] ?? "");
    expect(join).toEqual({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: ROOM_ID,
      token: JOIN_TOKEN,
    });

    expect(states.map((state) => state.status)).toEqual([
      "connecting",
      "connected",
    ]);
    const state = connectedState(transport);
    expect(state.peerId).toBe(PEER_A);
    expect(state.roomGeneration).toBe(3);
    // The role travels with membership so both client-side elections (who
    // answers a newcomer, who writes the durable snapshot) can skip viewers.
    expect(peerUpdates.at(-1)).toEqual([{ peerId: PEER_A, role: "editor" }]);
  });

  it("sends sealed frames on the matching channel, never plaintext", async () => {
    const { transport, cryptoCodec, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    expect(
      transport.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }))
        .ok,
    ).toBe(true);

    await vi.waitFor(() => expect(socket.sentBinary).toHaveLength(2));
    const sceneFrame = socket.sentBinary[0];
    const presenceFrame = socket.sentBinary[1];
    if (!sceneFrame || !presenceFrame) throw new Error("missing frame");
    expect(sceneFrame[0]).toBe(0x01);
    expect(presenceFrame[0]).toBe(0x02);

    // What reaches the socket is a sealed envelope, not a decodable message.
    for (const frame of [sceneFrame, presenceFrame]) {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("undecodable data frame");
      expect(dataFrame.payload[0]).toBe(REALTIME_CRYPTO_VERSION);
      expect(
        decodeCollaborationMessage(dataFrame.payload, dataFrame.channel).ok,
      ).toBe(false);
      expect(new TextDecoder().decode(dataFrame.payload)).not.toContain("eric");
    }

    // The room's own codec is what turns the ciphertext back into a message.
    const receiver = await roomCodec();
    const sceneData = decodeRelayDataFrame(sceneFrame);
    if (!sceneData) throw new Error("undecodable data frame");
    const opened = await receiver.open(sceneData.payload, "scene");
    if (!opened.ok) throw new Error(`expected to open: ${opened.error.code}`);
    expect(decodeCollaborationMessage(opened.plaintext, "scene").ok).toBe(true);
    expect(cryptoCodec.sealedMessageCount()).toBe(2);
  });

  it("keeps sealed scene frames in send order", async () => {
    const { transport, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);

    for (let sequence = 1; sequence <= 12; sequence += 1) {
      expect(
        transport.sendSceneMessage(sceneFromSession(state, { sequence })).ok,
      ).toBe(true);
    }

    await vi.waitFor(() => expect(socket.sentBinary).toHaveLength(12));
    const receiver = await roomCodec();
    const sequences: number[] = [];
    for (const frame of socket.sentBinary) {
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) throw new Error("undecodable data frame");
      const opened = await receiver.open(dataFrame.payload, "scene");
      if (!opened.ok) throw new Error(`expected to open: ${opened.error.code}`);
      const decoded = decodeCollaborationMessage(opened.plaintext, "scene");
      if (!decoded.ok) throw new Error("expected decodable plaintext");
      sequences.push(decoded.message.sequence);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("rejects sends before the join acknowledgment", async () => {
    const { transport, sockets } = await setup();
    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    sockets[0]?.open();

    const result = transport.sendSceneMessage(sceneMessage({ sequence: 1 }));
    expect(result).toEqual({
      ok: false,
      error: { code: "not-connected" },
    });
  });

  it("rejects messages that do not match the session identity", async () => {
    const { transport, connectAndJoin } = await setup();
    connectAndJoin();
    const state = connectedState(transport);

    const stale = sceneFromSession(state, { sequence: 1 });
    const result = transport.sendSceneMessage({
      ...stale,
      roomGeneration: state.roomGeneration + 1,
    });
    expect(result).toEqual({ ok: false, error: { code: "stale-session" } });
  });

  it("fails with queue-overflow when the socket buffer is over budget", async () => {
    const { transport, connectAndJoin } = await setup({ maxBufferedBytes: 8 });
    const socket = connectAndJoin();
    const state = connectedState(transport);
    socket.bufferedAmount = 9;

    const result = transport.sendSceneMessage(
      sceneFromSession(state, { sequence: 1 }),
    );
    expect(result).toEqual({ ok: false, error: { code: "queue-overflow" } });
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("counts frames still being sealed against the outbound budget", async () => {
    const { transport, connectAndJoin } = await setup({
      // Enough for one sealed frame, not two.
      maxBufferedBytes: 320,
    });
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    // The socket has not seen the first frame yet (it is still sealing), so
    // only the in-flight accounting can bound this second send.
    expect(socket.sentBinary).toHaveLength(0);
    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 2 })),
    ).toEqual({ ok: false, error: { code: "queue-overflow" } });

    // Once the queue drains, sending is possible again.
    await vi.waitFor(() => expect(socket.sentBinary).toHaveLength(1));
    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 2 })).ok,
    ).toBe(true);
  });

  it("refuses to send once the session's nonce budget is spent", async () => {
    const { transport, connectAndJoin } = await setup({ maxSealedMessages: 1 });
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 2 })),
    ).toEqual({ ok: false, error: { code: "crypto-exhausted" } });

    await vi.waitFor(() => expect(socket.sentBinary).toHaveLength(1));
  });

  it("delivers opened remote messages and drops frames it cannot authenticate", async () => {
    const { transport, messages, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const stranger = await roomCodec({ roomKey: generateRoomKey() });

    const remote = sceneMessage({
      sequence: 1,
      roomGeneration: 3,
      senderPeerId: PEER_B,
    });
    socket.receiveFrame(await remoteFrame(peer, remote, "scene"));
    await vi.waitFor(() => expect(messages).toEqual([remote]));

    const sceneSealed = await remoteFrame(
      peer,
      { ...remote, sequence: 2 },
      "scene",
    );
    // Sealed for the scene channel, delivered on the presence channel: the
    // authenticated metadata no longer matches, so it never gets decoded.
    const movedChannel = decodeRelayDataFrame(sceneSealed);
    if (!movedChannel) throw new Error("undecodable data frame");
    socket.receiveFrame(encodeRelayDataFrame("presence", movedChannel.payload));
    // A frame from a peer holding a different room key.
    socket.receiveFrame(await remoteFrame(stranger, remote, "scene"));
    // A tampered ciphertext byte.
    const tampered = await remoteFrame(
      peer,
      { ...remote, sequence: 3 },
      "scene",
    );
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    socket.receiveFrame(tampered);
    // Not a sealed frame at all, and an unknown channel byte.
    socket.receiveFrame(new Uint8Array([0x01, 0x7f, 1, 2]));
    socket.receiveFrame(new Uint8Array([0x7f, 1, 2]));

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages).toEqual([remote]);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("never authenticates two inbound frames at once", async () => {
    // The deterministic half of the replay-ordering fix: if `open` calls could
    // overlap, Web Crypto would be free to finish them out of order, and a
    // duplicate finishing before its original would claim the original's nonce.
    // Serialisation is the property that rules that out, so assert it directly
    // rather than relying on winning a race.
    let inFlight = 0;
    let maxInFlight = 0;
    const { messages, connectAndJoin } = await setup({
      wrapCrypto: (inner) => ({
        ...inner,
        async open(frame, channel) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            return await inner.open(frame, channel);
          } finally {
            inFlight -= 1;
          }
        },
      }),
    });
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const envelope = {
      roomGeneration: 3,
      senderPeerId: PEER_B,
    };
    const frames = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((sequence) =>
        remoteFrame(peer, sceneMessage({ sequence, ...envelope }), "scene"),
      ),
    );
    // One synchronous burst: every frame is handed over before any can drain.
    for (const frame of frames) socket.receiveFrame(frame);

    await vi.waitFor(() => expect(messages).toHaveLength(frames.length));
    expect(maxInFlight).toBe(1);
  });

  it("keeps the original when a replay races it, instead of losing it", async () => {
    // A hostile relay sends A, B, then A again. Authentication is asynchronous,
    // so if it ran eagerly the duplicate could finish first, claim A's nonce,
    // and get the real A dropped as the replay — losing a scene delta. Opening
    // inside the ordered chain is what makes that impossible.
    const { transport, messages, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const envelope = {
      roomGeneration: 3,
      senderPeerId: PEER_B,
    };
    const first = sceneMessage({ sequence: 1, ...envelope });
    const second = sceneMessage({ sequence: 2, ...envelope });
    const firstFrame = await remoteFrame(peer, first, "scene");
    const secondFrame = await remoteFrame(peer, second, "scene");

    socket.receiveFrame(firstFrame);
    socket.receiveFrame(secondFrame);
    socket.receiveFrame(firstFrame);

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    // Both originals delivered, in wire order; only the duplicate was dropped.
    expect(messages).toEqual([first, second]);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("refuses to queue frames too short to be sealed", async () => {
    // Header-only frames decode to a zero-byte payload. Charged by bytes alone
    // they would cost nothing, so any number of them could sit in a queue that
    // reports itself as bounded.
    let openCalls = 0;
    const { transport, messages, connectAndJoin } = await setup({
      maxInboundPendingBytes: 4_096,
      wrapCrypto: (inner) => ({
        ...inner,
        open(frame, channel) {
          openCalls += 1;
          return inner.open(frame, channel);
        },
      }),
    });
    const socket = connectAndJoin();
    const peer = await roomCodec();

    for (let index = 0; index < 5_000; index += 1) {
      socket.receiveFrame(new Uint8Array([0x01]));
      socket.receiveFrame(new Uint8Array([0x02]));
    }
    // A real frame behind the flood: waiting for *it* is what proves the queue
    // has actually been worked through, so `openCalls` is read after the fact
    // rather than before anything has had a chance to run.
    const real = sceneMessage({
      sequence: 1,
      roomGeneration: 3,
      senderPeerId: PEER_B,
    });
    socket.receiveFrame(await remoteFrame(peer, real, "scene"));

    await vi.waitFor(() => expect(messages).toEqual([real]));
    // Exactly one decryption: all 10,000 header-only frames were rejected at
    // admission and never reached the codec.
    expect(openCalls).toBe(1);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("bounds the inbound queue by entry count, not only by bytes", async () => {
    // Minimum-size sealed frames are ~30 bytes, so a byte-only budget would
    // admit thousands of them. The per-entry charge is what caps the count.
    const { transport, messages, connectAndJoin } = await setup({
      maxInboundPendingBytes: 4 * INBOUND_QUEUE_ENTRY_COST_BYTES,
    });
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const envelope = {
      roomGeneration: 3,
      senderPeerId: PEER_B,
    };
    const frames = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        remoteFrame(
          peer,
          sceneMessage({ sequence: index + 1, ...envelope }),
          "scene",
        ),
      ),
    );
    // One synchronous burst, so nothing can drain in between: the budget is the
    // only thing standing between a flood and unbounded queueing.
    for (const frame of frames) socket.receiveFrame(frame);

    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    // Far fewer than 40 admitted, even though 40 × ~250 bytes of ciphertext
    // would have fitted in a budget measured only in bytes. Over-budget frames
    // were dropped rather than queued, and the session is untouched.
    expect(messages.length).toBeLessThanOrEqual(4);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("reports scene-sync-required when the inbound budget drops a scene frame", async () => {
    // A dropped scene frame is not self-healing: if it was the sender's last
    // edit there is no later sequence to reveal a gap, and the session has no
    // periodic resync timer. The transport has to say so.
    let sceneSyncRequired = 0;
    const { transport, connectAndJoin } = await setup({
      maxInboundPendingBytes: INBOUND_QUEUE_ENTRY_COST_BYTES + 1,
    });
    transport.subscribe({
      onSceneSyncRequired: () => {
        sceneSyncRequired += 1;
      },
    });
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const envelope = {
      roomGeneration: 3,
      senderPeerId: PEER_B,
    };
    const sceneFrames = await Promise.all(
      [1, 2, 3, 4].map((sequence) =>
        remoteFrame(peer, sceneMessage({ sequence, ...envelope }), "scene"),
      ),
    );
    for (const frame of sceneFrames) socket.receiveFrame(frame);

    await vi.waitFor(() => expect(sceneSyncRequired).toBeGreaterThan(0));

    // Presence loss is volatile by design and must stay silent.
    const before = sceneSyncRequired;
    const presenceFrames = await Promise.all(
      [1, 2, 3, 4].map((sequence) =>
        remoteFrame(
          peer,
          presenceMessage({ sequence, ...envelope }),
          "presence",
        ),
      ),
    );
    for (const frame of presenceFrames) socket.receiveFrame(frame);
    await vi.waitFor(() =>
      expect(transport.getConnectionState().status).toBe("connected"),
    );
    expect(sceneSyncRequired).toBe(before);
  });

  it("coalesces dropped-scene reports into one per congestion episode", async () => {
    // Every dropped frame of one backlog asks for the same repair — a full
    // snapshot exchange — so reporting each drop would multiply identical
    // full-scene sends exactly when the inbound queue is already over budget.
    let sceneSyncRequired = 0;
    const peer = await roomCodec();
    const envelope = { roomGeneration: 3, senderPeerId: PEER_B };
    const frames = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((sequence) =>
        remoteFrame(peer, sceneMessage({ sequence, ...envelope }), "scene"),
      ),
    );
    // Room for exactly one queued frame: the burst's first frame is admitted
    // and every later one is dropped while it drains.
    const oneFrameCost =
      (frames[0]?.byteLength ?? 0) - 1 + INBOUND_QUEUE_ENTRY_COST_BYTES;
    const { transport, messages, connectAndJoin } = await setup({
      maxInboundPendingBytes: oneFrameCost + 1,
    });
    transport.subscribe({
      onSceneSyncRequired: () => {
        sceneSyncRequired += 1;
      },
    });
    const socket = connectAndJoin();

    // One synchronous burst: three drops, one report.
    for (const frame of frames.slice(0, 4)) socket.receiveFrame(frame);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(sceneSyncRequired).toBe(1);

    // The queue drained, so the next backlog is a new episode: it reports again.
    for (const frame of frames.slice(4)) socket.receiveFrame(frame);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(sceneSyncRequired).toBe(2);
  });

  it("re-reports a drop after a delivery even while the backlog drains", async () => {
    // The consumer that got the first report may not have been able to act on
    // it (a session holding its join barrier ignores the request), so the
    // episode must end at the next delivered scene message — waiting for a
    // full drain would silently swallow every later drop of the same backlog.
    let sceneSyncRequired = 0;
    const gates: Array<() => void> = [];
    const peer = await roomCodec();
    const envelope = { roomGeneration: 3, senderPeerId: PEER_B };
    const small = await Promise.all(
      [1, 2, 3].map((sequence) =>
        remoteFrame(peer, sceneMessage({ sequence, ...envelope }), "scene"),
      ),
    );
    // Bulky enough that it overflows a budget one small frame still fits in.
    const bulky = await remoteFrame(
      peer,
      sceneMessage({
        sequence: 4,
        ...envelope,
        elements: Array.from({ length: 20 }, (_, index) =>
          element({ id: `bulk-${index}` }),
        ),
      }),
      "scene",
    );
    const smallCost =
      (small[0]?.byteLength ?? 0) - 1 + INBOUND_QUEUE_ENTRY_COST_BYTES;
    const { transport, messages, connectAndJoin } = await setup({
      // Exactly two small frames fit.
      maxInboundPendingBytes: 2 * smallCost,
      wrapCrypto: (inner) => ({
        ...inner,
        async open(frame, channel) {
          await new Promise<void>((resolve) => gates.push(resolve));
          return inner.open(frame, channel);
        },
      }),
    });
    transport.subscribe({
      onSceneSyncRequired: () => {
        sceneSyncRequired += 1;
      },
    });
    const socket = connectAndJoin();

    // Two admitted (their opens gated), a third dropped: first report.
    for (const frame of small) socket.receiveFrame(frame);
    expect(sceneSyncRequired).toBe(1);

    // Deliver the first frame; the second is still queued, so no drain.
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()?.();
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    // A new drop while the backlog is still draining reports again.
    socket.receiveFrame(bulky);
    expect(sceneSyncRequired).toBe(2);

    // The second queued frame still drains normally afterwards.
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()?.();
    await vi.waitFor(() => expect(messages).toHaveLength(2));
  });

  it("keeps delivering to later subscribers when an earlier one throws", async () => {
    const { messages, transport, connectAndJoin } = await setup();
    // Registered after setup's own collector and before the late collector, so
    // the throw happens mid-fanout.
    transport.subscribe({
      onMessage: () => {
        throw new Error("subscriber A failed");
      },
    });
    const late: CollaborationMessage[] = [];
    transport.subscribe({ onMessage: (message) => late.push(message) });
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const envelope = { roomGeneration: 3, senderPeerId: PEER_B };

    const first = sceneMessage({ sequence: 1, ...envelope });
    socket.receiveFrame(await remoteFrame(peer, first, "scene"));
    await vi.waitFor(() => expect(late).toEqual([first]));
    expect(messages).toEqual([first]);

    // The channel's chain survived the throw: later frames still deliver.
    const second = sceneMessage({ sequence: 2, ...envelope });
    socket.receiveFrame(await remoteFrame(peer, second, "scene"));
    await vi.waitFor(() => expect(late).toEqual([first, second]));
    expect(messages).toEqual([first, second]);
  });

  it("keeps notifying state and peers when a subscriber throws", async () => {
    const { transport, connectAndJoin } = await setup();
    transport.subscribe({
      onConnectionStateChange: () => {
        throw new Error("state subscriber failed");
      },
      onRoomPeersChange: () => {
        throw new Error("peers subscriber failed");
      },
    });
    const states: ConnectionState[] = [];
    const peerUpdates: (readonly RoomPeer[])[] = [];
    transport.subscribe({
      onConnectionStateChange: (state) => states.push(state),
      onRoomPeersChange: (peers) => peerUpdates.push(peers),
    });

    // Without isolation the throw would propagate out of the socket callback
    // before the later subscriber ever heard about the join.
    connectAndJoin();
    expect(states.at(-1)?.status).toBe("connected");
    expect(peerUpdates).toHaveLength(1);
  });

  it("does not let a dead connection's backlog charge or block the next one", async () => {
    let openCalls = 0;
    const { transport, sockets, messages, connectAndJoin } = await setup({
      wrapCrypto: (inner) => ({
        ...inner,
        open(frame, channel) {
          openCalls += 1;
          return inner.open(frame, channel);
        },
      }),
    });
    const first = connectAndJoin();
    const peer = await roomCodec();
    const envelope = {
      roomGeneration: 3,
      senderPeerId: PEER_B,
    };
    const backlog = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((sequence) =>
        remoteFrame(peer, sceneMessage({ sequence, ...envelope }), "scene"),
      ),
    );

    // Deliver a backlog and abandon the socket in the same synchronous turn, so
    // nothing has had a chance to drain.
    for (const frame of backlog) first.receiveFrame(frame);
    transport.disconnect();

    // Not one of the stale frames is decrypted: the staleness check runs before
    // `open`, so a dead connection's backlog costs no crypto at all.
    await vi.waitFor(() =>
      expect(transport.getConnectionState().status).toBe("disconnected"),
    );
    expect(openCalls).toBe(0);
    expect(messages).toHaveLength(0);

    // The next connection starts with its own empty queues, so its very first
    // frame is delivered rather than queued behind the abandoned backlog.
    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    const second = sockets.at(-1);
    if (!second) throw new Error("no socket created");
    second.open();
    second.receiveControl(joinedNotice({ peerId: PEER_A, roomGeneration: 4 }));
    const fresh = sceneMessage({
      sequence: 1,
      roomGeneration: 4,
      senderPeerId: PEER_B,
    });
    second.receiveFrame(await remoteFrame(peer, fresh, "scene"));

    await vi.waitFor(() => expect(messages).toEqual([fresh]));
    expect(openCalls).toBe(1);
  });

  it("charges both channels against one outbound budget", async () => {
    // Sized from the real frames: each fits on its own, the two together do not.
    const probe = await setup();
    probe.connectAndJoin();
    const probeState = connectedState(probe.transport);
    const sceneBytes = wireSizeOf(
      sceneFromSession(probeState, { sequence: 1 }),
    );
    const presenceBytes = wireSizeOf(
      presenceFromSession(probeState, { sequence: 1 }),
    );
    probe.transport.close();

    const { transport, connectAndJoin } = await setup({
      maxBufferedBytes: sceneBytes + presenceBytes - 1,
    });
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    // Both channels share one socket, so presence must not get its own full
    // allowance while the scene frame is still sealing.
    expect(
      transport.sendPresenceMessage(
        presenceFromSession(state, { sequence: 1 }),
      ),
    ).toEqual({ ok: false, error: { code: "queue-overflow" } });

    // Once the scene frame drains, presence fits again on its own.
    await vi.waitFor(() => expect(socket.sentBinary).toHaveLength(1));
    expect(
      transport.sendPresenceMessage(presenceFromSession(state, { sequence: 1 }))
        .ok,
    ).toBe(true);
  });

  it("drops a replayed frame without disturbing the session", async () => {
    const { transport, messages, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const remote = sceneMessage({
      sequence: 1,
      roomGeneration: 3,
      senderPeerId: PEER_B,
    });
    const frame = await remoteFrame(peer, remote, "scene");

    socket.receiveFrame(frame);
    socket.receiveFrame(frame);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("degrades to disconnected when the relay closes the socket", async () => {
    const { transport, connectAndJoin } = await setup();
    const socket = connectAndJoin();

    // No close code at all: a socket that failed before any close frame, which
    // is what a network failure looks like. Retryable.
    socket.serverClose();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "transient",
    });
  });

  it("reports the relay's close code as the reason recovery acts on", async () => {
    const cases: {
      code: number | undefined;
      reason: DisconnectReason;
    }[] = [
      { code: RELAY_CLOSE_CODES.slowConsumer, reason: "transient" },
      { code: RELAY_CLOSE_CODES.roomAtCapacity, reason: "transient" },
      { code: RELAY_CLOSE_CODES.joinTimeout, reason: "transient" },
      { code: RELAY_CLOSE_CODES.unauthorized, reason: "unauthorized" },
      {
        code: RELAY_CLOSE_CODES.membershipRevoked,
        reason: "membership-revoked",
      },
      { code: RELAY_CLOSE_CODES.roomEnded, reason: "room-ended" },
      { code: RELAY_CLOSE_CODES.protocolViolation, reason: "protocol" },
      { code: RELAY_CLOSE_CODES.readOnlyRole, reason: "protocol" },
      // A normal close from the server side is still an unexpected end of
      // session for the client, so it is worth retrying.
      { code: 1000, reason: "transient" },
      { code: 1006, reason: "transient" },
    ];

    for (const { code, reason } of cases) {
      const { transport, connectAndJoin } = await setup();
      connectAndJoin().serverClose(code);
      expect(transport.getConnectionState()).toEqual({
        status: "disconnected",
        reason,
      });
    }
  });

  it("clears a stale disconnect reason when reconnecting", async () => {
    const { transport, connectAndJoin, sockets } = await setup();
    connectAndJoin().serverClose(RELAY_CLOSE_CODES.slowConsumer);

    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    expect(transport.getConnectionState()).toEqual({
      status: "connecting",
      roomId: ROOM_ID,
    });

    // A reason must never outlive the connection it describes: the caller ends
    // this one, so that is what it reports.
    sockets[1]?.open();
    transport.disconnect();
    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "idle",
    });
  });

  it("treats a joined notice for the wrong room as a broken connection", async () => {
    const { transport, sockets } = await setup();
    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    const socket = sockets[0];
    socket?.open();
    socket?.receiveControl(
      joinedNotice({
        roomId: ROOM_ID.replace("alpha", "beta") as typeof ROOM_ID,
      }),
    );

    expect(transport.getConnectionState()).toEqual({
      status: "disconnected",
      reason: "protocol",
    });
    expect(socket?.closedWith?.code).toBe(1000);
  });

  it("supports reconnecting after a disconnect with a fresh socket", async () => {
    const { transport, sockets, connectAndJoin } = await setup();
    const first = connectAndJoin();

    transport.disconnect();
    expect(parseRelayClientControl(first.sentText.at(-1) ?? "")).toEqual({
      control: "leave",
    });
    expect(first.closedWith?.code).toBe(1000);
    expect(transport.getConnectionState().status).toBe("disconnected");

    transport.connect({
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
    });
    const second = sockets.at(-1);
    expect(second).not.toBe(first);
    second?.open();
    second?.receiveControl(joinedNotice({ peerId: PEER_B, roomGeneration: 4 }));
    expect(connectedState(transport).peerId).toBe(PEER_B);
  });

  it("ignores events from a socket abandoned by disconnect", async () => {
    const { transport, connectAndJoin, messages } = await setup();
    const socket = connectAndJoin();
    const peer = await roomCodec();
    transport.disconnect();

    // Late events from the old socket must not resurrect the session.
    socket.receiveControl(joinedNotice());
    socket.receiveFrame(
      await remoteFrame(
        peer,
        sceneMessage({
          sequence: 1,
          roomGeneration: 3,
          senderPeerId: PEER_B,
        }),
        "scene",
      ),
    );
    socket.serverClose();
    await vi.waitFor(() =>
      expect(transport.getConnectionState().status).toBe("disconnected"),
    );
    expect(messages).toHaveLength(0);
  });

  it("does not send frames that finish sealing after a disconnect", async () => {
    const { transport, connectAndJoin } = await setup();
    const socket = connectAndJoin();
    const state = connectedState(transport);

    expect(
      transport.sendSceneMessage(sceneFromSession(state, { sequence: 1 })).ok,
    ).toBe(true);
    transport.disconnect();

    await vi.waitFor(() =>
      expect(transport.getConnectionState().status).toBe("disconnected"),
    );
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("close() is terminal and refuses further connects", async () => {
    const { transport, states, connectAndJoin } = await setup();
    connectAndJoin();

    transport.close();
    expect(transport.getConnectionState()).toEqual({ status: "closed" });
    expect(states.at(-1)?.status).toBe("closed");
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/closed/i);
    expect(transport.sendSceneMessage(sceneMessage({ sequence: 1 }))).toEqual({
      ok: false,
      error: { code: "not-connected" },
    });
  });

  it("throws when connecting an already-connected transport", async () => {
    const { transport, connectAndJoin } = await setup();
    connectAndJoin();
    expect(() =>
      transport.connect({
        roomId: ROOM_ID,
        joinToken: JOIN_TOKEN,
      }),
    ).toThrow(/already connected/i);
  });
});

/**
 * The aggregate that makes a wrong key non-silent on the realtime path (Plan 30).
 *
 * Every frame here is *individually* handled exactly as it was before — dropped,
 * with the session left up — so what is under test is only the verdict layered on
 * top: when it fires, when it must not, and that it never fires twice.
 */
describe("unreadable-room verdict on the realtime path", () => {
  /** A peer holding a different room key: every frame it seals fails to open. */
  const strangerCodec = (): Promise<RealtimeCryptoCodec> =>
    roomCodec({ roomKey: generateRoomKey() });

  const remoteSceneMessage = (sequence: number): CollaborationMessage =>
    sceneMessage({
      sequence,
      roomGeneration: 3,
      senderPeerId: PEER_B,
    });

  /**
   * `setup` plus a completed-`open` counter and a way to wait on it.
   *
   * Nearly every assertion in this block is that something did *not* happen, and
   * the inbound queue authenticates asynchronously — so "no verdict" only means
   * anything once the frames have actually been through the codec. Waiting on the
   * verdict itself cannot express that, and waiting on delivery cannot either:
   * these frames are never delivered.
   */
  const setupCounted = async () => {
    const counted = { opens: 0 };
    const harness = await setup({
      wrapCrypto: (inner) => ({
        ...inner,
        async open(frame, channel) {
          try {
            return await inner.open(frame, channel);
          } finally {
            counted.opens += 1;
          }
        },
      }),
    });
    return {
      ...harness,
      /** Waits until exactly `count` frames have finished authenticating. */
      awaitOpens: (count: number) =>
        vi.waitFor(() => expect(counted.opens).toBe(count)),
    };
  };

  it("reports the room once every arrived frame failed and none ever opened", async () => {
    const {
      transport,
      messages,
      unreadableVerdicts,
      connectAndJoin,
      awaitOpens,
    } = await setupCounted();
    const socket = connectAndJoin();
    const stranger = await strangerCodec();

    for (
      let sequence = 1;
      sequence <= REALTIME_UNREADABLE_FRAME_THRESHOLD;
      sequence += 1
    ) {
      socket.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    }
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD);

    expect(unreadableVerdicts.count).toBe(1);
    // The per-frame policy is untouched: nothing was delivered, nothing was
    // decoded, and the transport did not close itself. Ending the session is the
    // session's decision to make from this evidence, not the transport's.
    expect(messages).toEqual([]);
    expect(transport.getConnectionState().status).toBe("connected");

    // Once, not once per failing frame from here on — a wrong link keeps
    // receiving traffic for as long as the room is busy.
    socket.receiveFrame(
      await remoteFrame(stranger, remoteSceneMessage(99), "scene"),
    );
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD + 1);
    expect(unreadableVerdicts.count).toBe(1);
  });

  it("stays silent for fewer failures than the threshold", async () => {
    const { transport, unreadableVerdicts, connectAndJoin, awaitOpens } =
      await setupCounted();
    const socket = connectAndJoin();
    const stranger = await strangerCodec();

    for (
      let sequence = 1;
      sequence < REALTIME_UNREADABLE_FRAME_THRESHOLD;
      sequence += 1
    ) {
      socket.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    }
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD - 1);

    // A corrupted, tampered or replayed frame under a *correct* key looks exactly
    // like this, and it must keep costing nothing but the frame.
    expect(unreadableVerdicts.count).toBe(0);
    expect(transport.getConnectionState().status).toBe("connected");
  });

  it("counts only frames that reached the codec, not everything that arrived", async () => {
    const { unreadableVerdicts, connectAndJoin, awaitOpens } =
      await setupCounted();
    const socket = connectAndJoin();
    const stranger = await strangerCodec();

    // Rejected before the codec: too short to be a sealed frame, and an unknown
    // channel byte. Neither is evidence about the key, and counting them would
    // let a hostile relay end any session with three bytes.
    socket.receiveFrame(new Uint8Array([0x01, 1, 2]));
    socket.receiveFrame(new Uint8Array([0x7f, 1, 2]));
    for (
      let sequence = 1;
      sequence < REALTIME_UNREADABLE_FRAME_THRESHOLD;
      sequence += 1
    ) {
      socket.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    }

    // The junk frames contributed nothing: the real failures are still one short.
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD - 1);
    expect(unreadableVerdicts.count).toBe(0);
  });

  it("never reports a room after a single frame has opened", async () => {
    const { messages, unreadableVerdicts, connectAndJoin, awaitOpens } =
      await setupCounted();
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const stranger = await strangerCodec();

    socket.receiveFrame(
      await remoteFrame(peer, remoteSceneMessage(1), "scene"),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    // One success proves the key opens this room, so everything after it is
    // corruption, tampering or replay — none of which may end the session, however
    // many of them arrive.
    const failures = REALTIME_UNREADABLE_FRAME_THRESHOLD * 4;
    for (let sequence = 2; sequence <= failures + 1; sequence += 1) {
      socket.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    }
    await awaitOpens(failures + 1);

    expect(messages).toHaveLength(1);
    expect(unreadableVerdicts.count).toBe(0);
  });

  it("accumulates evidence across reconnects", async () => {
    const { unreadableVerdicts, connectAndJoin, awaitOpens } =
      await setupCounted();
    const first = connectAndJoin();
    const stranger = await strangerCodec();

    // The question is about the *key*, which outlives any one socket — so a
    // reconnect must not hand a wrong link a clean slate every time the network
    // blips and leave the user staring at a blank canvas again.
    for (
      let sequence = 1;
      sequence < REALTIME_UNREADABLE_FRAME_THRESHOLD;
      sequence += 1
    ) {
      first.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    }
    // Strictly before the reconnect: a socket that goes away drops whatever its
    // queue still holds, so unauthenticated frames would prove nothing.
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD - 1);
    expect(unreadableVerdicts.count).toBe(0);

    first.serverClose(1006);
    const second = connectAndJoin();
    second.receiveFrame(
      await remoteFrame(stranger, remoteSceneMessage(1), "scene"),
    );
    await awaitOpens(REALTIME_UNREADABLE_FRAME_THRESHOLD);

    expect(unreadableVerdicts.count).toBe(1);
  });

  it("waits for a frame that is still decrypting on the other channel", async () => {
    // `scene` and `presence` authenticate on independent chains, so a valid frame
    // can still be in the codec while enough unopenable frames finish ahead of it
    // on the other one. Judging at that moment would call a healthy session's key
    // wrong — and the verdict is terminal, so there is no taking it back.
    let releaseScene: (() => void) | undefined;
    const counted = { opens: 0 };
    const { messages, unreadableVerdicts, connectAndJoin } = await setup({
      wrapCrypto: (inner) => ({
        ...inner,
        async open(frame, channel) {
          if (channel === "scene" && !releaseScene) {
            await new Promise<void>((resolve) => {
              releaseScene = resolve;
            });
          }
          try {
            return await inner.open(frame, channel);
          } finally {
            counted.opens += 1;
          }
        },
      }),
    });
    const socket = connectAndJoin();
    const peer = await roomCodec();
    const stranger = await strangerCodec();

    // Received first, and held mid-decrypt.
    socket.receiveFrame(
      await remoteFrame(peer, remoteSceneMessage(1), "scene"),
    );
    await vi.waitFor(() => expect(releaseScene).toBeDefined());

    // Meanwhile the whole threshold is reached on the presence chain.
    for (
      let sequence = 1;
      sequence <= REALTIME_UNREADABLE_FRAME_THRESHOLD;
      sequence += 1
    ) {
      socket.receiveFrame(
        await remoteFrame(
          stranger,
          presenceMessage({
            sequence,
            roomGeneration: 3,
            senderPeerId: PEER_B,
          }),
          "presence",
        ),
      );
    }
    await vi.waitFor(() =>
      expect(counted.opens).toBe(REALTIME_UNREADABLE_FRAME_THRESHOLD),
    );
    // The verdict is armed but must not have been taken.
    expect(unreadableVerdicts.count).toBe(0);

    releaseScene?.();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    // The late success cancels it for good rather than merely delaying it.
    expect(unreadableVerdicts.count).toBe(0);
  });

  it("does not let later frames postpone a verdict that is already armed", async () => {
    // The wait is fenced to the frames already in flight when the verdict armed,
    // not to the queues going empty. A busy room never goes empty, and a wrong
    // link must not stay silent for as long as the room stays interesting.
    const gates: (() => void)[] = [];
    const { unreadableVerdicts, connectAndJoin } = await setup({
      wrapCrypto: (inner) => ({
        ...inner,
        async open(frame, channel) {
          await new Promise<void>((resolve) => gates.push(resolve));
          return inner.open(frame, channel);
        },
      }),
    });
    const socket = connectAndJoin();
    const stranger = await strangerCodec();
    let sequence = 0;
    const admitFailingFrame = async (): Promise<void> => {
      sequence += 1;
      socket.receiveFrame(
        await remoteFrame(stranger, remoteSceneMessage(sequence), "scene"),
      );
    };
    /** Releases the frame currently held in the codec and lets it settle. */
    const releaseOne = async (expectedGates: number): Promise<void> => {
      await vi.waitFor(() => expect(gates).toHaveLength(expectedGates));
      gates.shift()?.();
      await vi.waitFor(() => expect(gates).toHaveLength(expectedGates - 1));
    };

    // Two failures settle, leaving the count one short of the threshold.
    await admitFailingFrame();
    await releaseOne(1);
    await admitFailingFrame();
    await releaseOne(1);
    expect(unreadableVerdicts.count).toBe(0);

    // Two more are admitted; releasing the first crosses the threshold and arms
    // the verdict with the second still in flight.
    await admitFailingFrame();
    await admitFailingFrame();
    await releaseOne(1);
    expect(unreadableVerdicts.count).toBe(0);

    // Traffic keeps coming *after* the arming moment. These are outside the
    // cohort, so they must not extend the wait by even one frame.
    await admitFailingFrame();
    await admitFailingFrame();

    // Draining only the last cohort member is enough to report.
    await releaseOne(1);
    await vi.waitFor(() => expect(unreadableVerdicts.count).toBe(1));
    expect(gates).not.toHaveLength(0);
  });
});
