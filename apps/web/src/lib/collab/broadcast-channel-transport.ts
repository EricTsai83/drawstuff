import { nanoid } from "nanoid";

import {
  clientIdSchema,
  decodeCollaborationMessage,
  encodeCollaborationMessage,
  peerIdSchema,
  type ClientId,
  type CollaborationMessage,
  type MessageChannel,
  type PeerId,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import type {
  CollaborationTransport,
  ConnectionState,
  RoomPeer,
  SendResult,
  TransportSubscriber,
} from "@drawstuff/collaboration/transport";

/**
 * Plan 11 POC-only transport: same-origin tabs in one browser exchange
 * protocol-encoded messages over a `BroadcastChannel` per room. Deleted in
 * Plan 12 when the relay transport replaces the local wiring.
 *
 * Local rooms have no epochs (no relay to restart), so every session runs in
 * room generation 1; real generations arrive with the relay.
 */
const POC_ROOM_GENERATION = 1;

const CHANNEL_NAME_PREFIX = "drawstuff-collab-poc";

/** The `BroadcastChannel` surface the transport uses, injectable so tests
 *  run against a deterministic in-memory hub. */
export type BroadcastChannelLike = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

export type BroadcastChannelTransportOptions = {
  createChannel?: (name: string) => BroadcastChannelLike;
};

/**
 * Peer discovery control frames. `hello` announces membership (`isReply`
 * breaks the response loop), `leave` retracts it; scene/presence frames carry
 * codec-encoded protocol bytes and nothing else.
 */
type WireFrame =
  | { kind: "hello"; peerId: string; clientId: string; isReply: boolean }
  | { kind: "leave"; peerId: string }
  | { kind: "scene" | "presence"; bytes: Uint8Array };

/**
 * Realm-safe `Uint8Array` acceptance: a structured clone from another
 * browsing context (or the test hub) may carry a foreign-realm view, where
 * `instanceof` is false but the `ArrayBuffer.isView` internal-slot check
 * still holds.
 */
const asUint8Array = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value) && value.constructor.name === "Uint8Array") {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
};

const isWireFrame = (data: unknown): data is WireFrame => {
  if (typeof data !== "object" || data === null || !("kind" in data)) {
    return false;
  }
  const frame = data as Partial<WireFrame> & { kind: unknown };
  switch (frame.kind) {
    case "hello":
      return (
        typeof (frame as { peerId?: unknown }).peerId === "string" &&
        typeof (frame as { clientId?: unknown }).clientId === "string" &&
        typeof (frame as { isReply?: unknown }).isReply === "boolean"
      );
    case "leave":
      return typeof (frame as { peerId?: unknown }).peerId === "string";
    case "scene":
    case "presence":
      return asUint8Array((frame as { bytes?: unknown }).bytes) !== undefined;
    default:
      return false;
  }
};

export function createBroadcastChannelTransport(
  options: BroadcastChannelTransportOptions = {},
): CollaborationTransport {
  const createChannel =
    options.createChannel ??
    ((name: string): BroadcastChannelLike => new BroadcastChannel(name));

  type Session = {
    roomId: RoomId;
    clientId: ClientId;
    peerId: PeerId;
    channel: BroadcastChannelLike;
    /** Other tabs' membership announcements; self is added on read. */
    members: Map<string, ClientId>;
  };

  const subscribers = new Set<TransportSubscriber>();
  let session: Session | undefined;
  let closed = false;

  const connectionState = (): ConnectionState => {
    if (closed) return { status: "closed" };
    if (!session) return { status: "disconnected" };
    return {
      status: "connected",
      roomId: session.roomId,
      clientId: session.clientId,
      peerId: session.peerId,
      roomGeneration: POC_ROOM_GENERATION,
    };
  };

  const notifyConnectionState = (): void => {
    const state = connectionState();
    for (const subscriber of subscribers) {
      subscriber.onConnectionStateChange?.(state);
    }
  };

  const notifyRoomPeers = (): void => {
    if (!session) return;
    const peers: RoomPeer[] = [
      { peerId: session.peerId, clientId: session.clientId },
      ...[...session.members.entries()].map(([peerId, clientId]) => ({
        peerId: peerId as PeerId,
        clientId,
      })),
    ];
    for (const subscriber of subscribers) {
      subscriber.onRoomPeersChange?.(peers);
    }
  };

  const handleFrame = (data: unknown): void => {
    const activeSession = session;
    if (!activeSession || !isWireFrame(data)) return;

    switch (data.kind) {
      case "hello": {
        const peerId = peerIdSchema.safeParse(data.peerId);
        const clientId = clientIdSchema.safeParse(data.clientId);
        if (!peerId.success || !clientId.success) return;
        const known = activeSession.members.get(peerId.data);
        if (known !== clientId.data) {
          activeSession.members.set(peerId.data, clientId.data);
          notifyRoomPeers();
        }
        if (!data.isReply) {
          activeSession.channel.postMessage({
            kind: "hello",
            peerId: activeSession.peerId,
            clientId: activeSession.clientId,
            isReply: true,
          } satisfies WireFrame);
        }
        return;
      }
      case "leave": {
        if (activeSession.members.delete(data.peerId)) notifyRoomPeers();
        return;
      }
      case "scene":
      case "presence": {
        const bytes = asUint8Array(data.bytes);
        if (!bytes) return;
        const decoded = decodeCollaborationMessage(bytes, data.kind);
        // Malformed or oversize frames are protocol violations from another
        // tab; this receiver drops them and stays consistent via snapshots.
        if (!decoded.ok) return;
        for (const subscriber of subscribers) {
          subscriber.onMessage?.(decoded.message);
        }
        return;
      }
    }
  };

  const handlePageHide = (): void => {
    // Best-effort membership retraction when the tab goes away without a
    // React unmount (close/navigation); the channel dies with the page.
    const activeSession = session;
    if (!activeSession) return;
    activeSession.channel.postMessage({
      kind: "leave",
      peerId: activeSession.peerId,
    } satisfies WireFrame);
  };

  const teardownSession = (announceLeave: boolean): void => {
    if (!session) return;
    const endingSession = session;
    session = undefined;
    if (announceLeave) {
      endingSession.channel.postMessage({
        kind: "leave",
        peerId: endingSession.peerId,
      } satisfies WireFrame);
    }
    endingSession.channel.onmessage = null;
    endingSession.channel.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", handlePageHide);
    }
    notifyConnectionState();
  };

  const send = (
    message: CollaborationMessage,
    channel: MessageChannel,
  ): SendResult => {
    if (!session) return { ok: false, error: { code: "not-connected" } };
    if (
      message.roomId !== session.roomId ||
      message.senderClientId !== session.clientId ||
      message.senderPeerId !== session.peerId ||
      message.roomGeneration !== POC_ROOM_GENERATION
    ) {
      return { ok: false, error: { code: "stale-session" } };
    }
    const encoded = encodeCollaborationMessage(message);
    if (!encoded.ok) return encoded;
    // postMessage is synchronous fire-and-forget: there is no outbound queue
    // to bound, so `queue-overflow` cannot occur on this transport.
    session.channel.postMessage({
      kind: channel,
      bytes: encoded.bytes,
    } satisfies WireFrame);
    return { ok: true };
  };

  return {
    getConnectionState: connectionState,
    connect({ roomId, clientId }) {
      if (closed) throw new Error("Transport is closed");
      if (session) throw new Error("Transport is already connected");

      const channel = createChannel(`${CHANNEL_NAME_PREFIX}:${roomId}`);
      const peerId = peerIdSchema.parse(`bc-${nanoid()}`);
      session = { roomId, clientId, peerId, channel, members: new Map() };
      channel.onmessage = (event) => {
        handleFrame(event.data);
      };
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", handlePageHide);
      }
      notifyConnectionState();
      notifyRoomPeers();
      channel.postMessage({
        kind: "hello",
        peerId,
        clientId,
        isReply: false,
      } satisfies WireFrame);
    },
    disconnect() {
      teardownSession(true);
    },
    close() {
      if (closed) return;
      closed = true;
      const wasConnected = session !== undefined;
      teardownSession(true);
      if (!wasConnected) notifyConnectionState();
      subscribers.clear();
    },
    sendSceneMessage: (message) => send(message, "scene"),
    sendPresenceMessage: (message) => send(message, "presence"),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}
