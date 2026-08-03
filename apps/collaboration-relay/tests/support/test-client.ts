import {
  COLLABORATION_PROTOCOL_VERSION,
  createInboundMessageGate,
  type ClientId,
  type CollaborationMessage,
  type InboundMessageGate,
  type PresenceMessage,
  type RoomId,
  type SceneMessage,
  type SyncedElement,
} from "@drawstuff/collaboration/protocol";
import { createRelayWebSocketTransport } from "@drawstuff/collaboration/relay-client";
import type {
  ConnectionState,
  RoomPeer,
} from "@drawstuff/collaboration/transport";

/**
 * Minimal collaboration client for relay integration tests: a last-writer-wins
 * element store plus the real protocol codec, inbound gate, and relay
 * transport. It mirrors the production session's convergence moves — snapshot
 * on join, snapshot reply when a received snapshot lacks local state, snapshot
 * on sequence gaps — without importing the canvas engine, so relay tests stay
 * inside the relay's dependency boundary.
 */

export type TestElement = SyncedElement & { label?: string };

/** Both sides resolve conflicts identically, so snapshot exchange converges:
 *  higher version wins; equal versions tie-break on the lower nonce. */
const remoteWins = (local: TestElement, remote: TestElement): boolean =>
  remote.version > local.version ||
  (remote.version === local.version &&
    remote.versionNonce < local.versionNonce);

export async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type TestClient = {
  connect(): Promise<void>;
  disconnect(): void;
  close(): void;
  /** Create or overwrite an element and broadcast it as a scene delta. */
  upsertElement(id: string, label: string): void;
  sendPresence(x: number, y: number): void;
  digest(): string;
  elementIds(): string[];
  peers(): readonly RoomPeer[];
  presenceReceived(): readonly PresenceMessage[];
  connectionState(): ConnectionState;
  roomGeneration(): number | undefined;
};

export function createTestClient(options: {
  url: string;
  roomId: RoomId;
  clientId: ClientId;
  /** Distinct per client so concurrently created nonces never collide. */
  nonceSeed: number;
}): TestClient {
  const { url, roomId, clientId } = options;
  const transport = createRelayWebSocketTransport({ url });
  const elements = new Map<string, TestElement>();
  const presenceReceived: PresenceMessage[] = [];

  type ConnectedState = Extract<ConnectionState, { status: "connected" }>;
  let connected: ConnectedState | undefined;
  let gate: InboundMessageGate | undefined;
  let currentPeers: readonly RoomPeer[] = [];
  let sceneSequence = 0;
  let presenceSequence = 0;
  let messageCounter = 0;
  let nonceCounter = options.nonceSeed * 1_000_000;

  type MessageEnvelope = Pick<
    PresenceMessage,
    | "protocolVersion"
    | "messageId"
    | "roomId"
    | "roomGeneration"
    | "senderClientId"
    | "senderPeerId"
    | "sequence"
  >;

  const envelope = (
    session: ConnectedState,
    sequence: number,
  ): MessageEnvelope => ({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    messageId: `m-${++messageCounter}`,
    roomId: session.roomId,
    roomGeneration: session.roomGeneration,
    senderClientId: session.clientId,
    senderPeerId: session.peerId,
    sequence,
  });

  const sendScene = (
    type: SceneMessage["type"],
    sceneElements: TestElement[],
  ): void => {
    if (!connected) return;
    const shared = envelope(connected, sceneSequence + 1);
    const payload = { elements: sceneElements };
    const message: SceneMessage =
      type === "scene-init"
        ? { ...shared, type: "scene-init", payload }
        : { ...shared, type: "scene-update", payload };
    if (transport.sendSceneMessage(message).ok) {
      sceneSequence += 1;
    }
  };

  const sendSnapshot = (): void => {
    sendScene("scene-init", [...elements.values()]);
  };

  const mergeRemote = (remoteElements: readonly SyncedElement[]): void => {
    for (const remote of remoteElements as readonly TestElement[]) {
      const local = elements.get(remote.id);
      if (!local || remoteWins(local, remote)) {
        elements.set(remote.id, remote);
      }
    }
  };

  /** Mirrors the production session's snapshot-as-convergence-probe: reply
   *  only when we hold syncable state the sender's snapshot lacks. */
  const snapshotNeedsReply = (
    remoteElements: readonly SyncedElement[],
  ): boolean => {
    const remoteById = new Map(remoteElements.map((el) => [el.id, el]));
    return [...elements.values()].some((local) => {
      const remote = remoteById.get(local.id);
      return (
        remote === undefined ||
        local.version > remote.version ||
        (local.version === remote.version &&
          local.versionNonce !== remote.versionNonce)
      );
    });
  };

  const handleMessage = (message: CollaborationMessage): void => {
    if (!gate) return;
    const verdict = gate.accept(message);
    if (verdict.action === "reject") return;
    if (message.type === "presence") {
      presenceReceived.push(message);
      return;
    }
    const hadNewerState =
      message.type === "scene-init" &&
      snapshotNeedsReply(message.payload.elements);
    mergeRemote(message.payload.elements);
    if (hadNewerState || verdict.sceneSyncRequired) {
      sendSnapshot();
    }
  };

  transport.subscribe({
    onConnectionStateChange(state) {
      if (state.status === "connected") {
        connected = state;
        gate = createInboundMessageGate({
          roomId: state.roomId,
          roomGeneration: state.roomGeneration,
        });
        sceneSequence = 0;
        presenceSequence = 0;
        sendSnapshot();
        return;
      }
      connected = undefined;
      gate = undefined;
      currentPeers = [];
    },
    onMessage: handleMessage,
    onRoomPeersChange(peers) {
      currentPeers = peers;
    },
  });

  return {
    async connect() {
      transport.connect({ roomId, clientId });
      await waitUntil(
        () => connected !== undefined,
        `client ${clientId} to join ${roomId}`,
      );
    },
    disconnect() {
      transport.disconnect();
    },
    close() {
      transport.close();
    },
    upsertElement(id, label) {
      const existing = elements.get(id);
      const next: TestElement = {
        id,
        version: (existing?.version ?? 0) + 1,
        versionNonce: ++nonceCounter,
        isDeleted: false,
        label,
      };
      elements.set(id, next);
      sendScene("scene-update", [next]);
    },
    sendPresence(x, y) {
      if (!connected) return;
      const message: PresenceMessage = {
        ...envelope(connected, presenceSequence + 1),
        type: "presence",
        payload: {
          pointer: { x, y, tool: "pointer" },
          button: "up",
          username: clientId,
          selectedElementIds: [],
          idleState: "active",
        },
      };
      if (transport.sendPresenceMessage(message).ok) {
        presenceSequence += 1;
      }
    },
    digest() {
      const sorted = [...elements.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      return JSON.stringify(sorted);
    },
    elementIds() {
      return [...elements.keys()].sort();
    },
    peers: () => currentPeers,
    presenceReceived: () => presenceReceived,
    connectionState: () => transport.getConnectionState(),
    roomGeneration: () => connected?.roomGeneration,
  };
}
