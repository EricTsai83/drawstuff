import {
  clientIdSchema,
  peerIdSchema,
  roomIdSchema,
  syncedElementSchema,
  type ClientId,
  type PeerId,
  type PresenceMessage,
  type RoomId,
  type SceneMessage,
  type SyncedElement,
} from "../src/protocol.ts";
import {
  createRealtimeCryptoCodec,
  roomKeySchema,
  type RealtimeCryptoCodec,
  type RealtimeCryptoCodecOptions,
} from "../src/realtime-crypto.ts";
import type {
  CollaborationTransport,
  ConnectionState,
} from "../src/transport.ts";

export const ROOM_ID = roomIdSchema.parse("room-alpha");
export const CLIENT_A = clientIdSchema.parse("client-a");
export const CLIENT_B = clientIdSchema.parse("client-b");
export const PEER_A = peerIdSchema.parse("peer-a");
export const PEER_B = peerIdSchema.parse("peer-b");
/** Opaque placeholder: only the relay verifies token signatures. */
export const JOIN_TOKEN = "test-join-token";
/** Shared room key: every peer in these tests is in the same room. */
export const ROOM_KEY = roomKeySchema.parse(
  "T0PSTFR2c2hhcmVkLXRlc3Qtcm9vbS1rZXktMDAwMDA",
);

/** Codec for one peer; every peer in these tests shares the room key. */
export function roomCodec(
  overrides: Partial<RealtimeCryptoCodecOptions> = {},
): Promise<RealtimeCryptoCodec> {
  return createRealtimeCryptoCodec({
    roomKey: ROOM_KEY,
    roomId: ROOM_ID,
    authGeneration: 1,
    ...overrides,
  });
}

let messageCounter = 0;
const nextMessageId = (): string => `m-${++messageCounter}`;

export function element(
  overrides: Record<string, unknown> = {},
): SyncedElement {
  return syncedElementSchema.parse({
    id: "el-1",
    version: 1,
    versionNonce: 42,
    isDeleted: false,
    ...overrides,
  });
}

type EnvelopeOverrides = {
  roomId?: RoomId;
  roomGeneration?: number;
  senderClientId?: ClientId;
  senderPeerId?: PeerId;
};

export function sceneMessage(
  input: EnvelopeOverrides & {
    type?: SceneMessage["type"];
    sequence: number;
    elements?: SyncedElement[];
  },
): SceneMessage {
  return {
    protocolVersion: 1,
    messageId: nextMessageId(),
    roomId: input.roomId ?? ROOM_ID,
    roomGeneration: input.roomGeneration ?? 1,
    senderClientId: input.senderClientId ?? CLIENT_A,
    senderPeerId: input.senderPeerId ?? PEER_A,
    sequence: input.sequence,
    type: input.type ?? "scene-update",
    payload: { elements: input.elements ?? [element()] },
  };
}

export function presenceMessage(
  input: EnvelopeOverrides & {
    sequence: number;
    payload?: Partial<PresenceMessage["payload"]>;
  },
): PresenceMessage {
  return {
    protocolVersion: 1,
    messageId: nextMessageId(),
    roomId: input.roomId ?? ROOM_ID,
    roomGeneration: input.roomGeneration ?? 1,
    senderClientId: input.senderClientId ?? CLIENT_A,
    senderPeerId: input.senderPeerId ?? PEER_A,
    sequence: input.sequence,
    type: "presence",
    payload: {
      pointer: { x: 10, y: 20, tool: "pointer" },
      button: "up",
      username: "eric",
      selectedElementIds: ["el-1"],
      idleState: "active",
      ...input.payload,
    },
  };
}

type ConnectedState = Extract<ConnectionState, { status: "connected" }>;

export function connectedState(
  transport: CollaborationTransport,
): ConnectedState {
  const state = transport.getConnectionState();
  if (state.status !== "connected") {
    throw new Error(`Expected connected transport, got "${state.status}"`);
  }
  return state;
}

const sessionEnvelope = (state: ConnectedState): EnvelopeOverrides => ({
  roomId: state.roomId,
  roomGeneration: state.roomGeneration,
  senderClientId: state.clientId,
  senderPeerId: state.peerId,
});

export function sceneFromSession(
  state: ConnectedState,
  input: {
    type?: SceneMessage["type"];
    sequence: number;
    elements?: SyncedElement[];
  },
): SceneMessage {
  return sceneMessage({ ...sessionEnvelope(state), ...input });
}

export function presenceFromSession(
  state: ConnectedState,
  input: { sequence: number },
): PresenceMessage {
  return presenceMessage({ ...sessionEnvelope(state), ...input });
}

/** Deliberately bypasses static typing to test runtime rejection paths. */
export function asMessage(value: unknown): SceneMessage {
  return value as SceneMessage;
}
