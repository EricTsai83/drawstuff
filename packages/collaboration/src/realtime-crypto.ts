import { z } from "zod";

import type { MessageChannel } from "./codec.ts";
import { COLLABORATION_PROTOCOL_VERSION, type RoomId } from "./messages.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";

/**
 * End-to-end encryption for realtime collaboration payloads.
 *
 * The room key is generated in the browser and never leaves it: it lives only
 * in the URL fragment and in client memory, and is never sent to the app
 * backend, to the relay, or to any log, database, or error payload. What travels
 * is a sealed frame — a version byte, a random IV, and AES-GCM ciphertext — so
 * the relay routes bytes it has no way to interpret, and the frame carries no
 * hint of who sent it.
 *
 * The room key is never used as an encryption key directly. HKDF-SHA256 derives
 * one AES-GCM key per (room, authorization generation, purpose), which buys
 * three separations:
 *
 * - Realtime traffic, durable snapshots and binary assets use different
 *   purposes, so one leaked derived key never unlocks the others.
 * - A room's authorization generation is part of the salt, so rotating it
 *   (`collaborationRoom.rotateGeneration`) produces a key that cannot open the
 *   previous generation's ciphertext.
 * - The wire protocol version is part of the info string, so a future protocol
 *   revision cannot be attacked by replaying frames across versions.
 *
 * Only primitives from Web Crypto are used; nothing here implements a cipher,
 * a MAC, or a KDF by hand.
 */

/**
 * Sealed-frame envelope version; bumped only on a breaking layout change.
 *
 * The nonce strategy is the standard one for AES-GCM: a fresh 96-bit random IV
 * per message, with an enforced ceiling on messages per key
 * (`MAX_SEALED_MESSAGES_PER_SENDER`). Two earlier shapes were tried and
 * discarded — a per-room-generation key with a random nonce prefix plus a
 * counter, whose cross-session uniqueness rested on a birthday bound nothing
 * could enforce; and a per-sender-session key with a plain counter, which was
 * unconditionally unique but needed a session handshake, a salt and a peer id in
 * every frame header, a receive-side key cache, and a key/counter invariant
 * whose violation would be silent and catastrophic. This shape is what NIST
 * SP 800-38D §8.3 describes, it keeps sender identity out of the frame, and its
 * failure mode is a refusal to seal rather than silent nonce reuse.
 */
export const REALTIME_CRYPTO_VERSION = 3;

/** Room key size. 256 bits of `getRandomValues` entropy. */
export const ROOM_KEY_BYTES = 32;

/** Derived AES-GCM key size. */
const DERIVED_KEY_BITS = 256;

/** AES-GCM standard nonce length; the only length with a hardware-fast path. */
export const REALTIME_NONCE_BYTES = 12;

/** AES-GCM authentication tag length appended to every ciphertext. */
export const AES_GCM_TAG_BYTES = 16;

const VERSION_BYTES = 1;

/**
 * Sealed frame layout — fixed size, no variable fields:
 *
 * ```
 * 0                  envelope version
 * 1 .. 13            random IV
 * rest               AES-GCM ciphertext ‖ tag
 * ```
 */
export const REALTIME_SEALED_HEADER_BYTES =
  VERSION_BYTES + REALTIME_NONCE_BYTES;

/** Bytes a sealed frame adds to its plaintext: header plus GCM tag. */
export const REALTIME_SEALED_OVERHEAD_BYTES =
  REALTIME_SEALED_HEADER_BYTES + AES_GCM_TAG_BYTES;

/** Smallest byte length that could still be a sealed frame. */
export const MIN_REALTIME_SEALED_FRAME_BYTES =
  REALTIME_SEALED_OVERHEAD_BYTES + 1;

export function sealedFrameByteLength(plaintextByteLength: number): number {
  return plaintextByteLength + REALTIME_SEALED_OVERHEAD_BYTES;
}

/**
 * NIST SP 800-38D §8.3 caps invocations of AES-GCM under one key at 2^32 when
 * the IV is random, which holds the collision probability at or below 2^-32.
 */
export const MAX_SEALED_MESSAGES_PER_KEY = 2 ** 32;

/**
 * Relay's per-room connection cap. Duplicated as a plain number rather than
 * imported: this package is the protocol boundary and must not depend on a
 * service's configuration. The relay's own limit is the authority; this is the
 * conservative assumption the budget below is derived from, and the contract
 * test pins the arithmetic.
 */
const ASSUMED_MAX_ROOM_MEMBERS = 32;

/**
 * Messages one sender may seal under one derived key. Enforced — `seal` refuses
 * rather than continuing past it.
 *
 * The limit that actually matters is `MAX_SEALED_MESSAGES_PER_KEY` across *all*
 * members, and a client can only ever count its own messages. Dividing the
 * global limit by the room's member cap turns it into something a single client
 * can enforce locally: if no sender exceeds this, the room as a whole cannot
 * exceed the global limit. That is the piece both earlier designs lacked — one
 * had an unenforceable threshold, the other had no budget at all.
 *
 * For scale: a client sending presence at the 33ms throttle for a full 24-hour
 * room lifetime produces about 2^21.3 messages, so this leaves ~51× headroom.
 */
export const MAX_SEALED_MESSAGES_PER_SENDER =
  MAX_SEALED_MESSAGES_PER_KEY / ASSUMED_MAX_ROOM_MEMBERS;

/**
 * Birthday bound on IV collisions across `messageCount` messages sealed under
 * one derived key: `n(n-1) / 2^(ivBits + 1)`.
 *
 * Exported so the budget above is checkable rather than asserted: the contract
 * test pins the bound at both the per-sender and the global limit.
 */
export function ivCollisionProbabilityBound(messageCount: number): number {
  if (messageCount <= 1) return 0;
  return (
    (messageCount * (messageCount - 1)) / 2 ** (8 * REALTIME_NONCE_BYTES + 1)
  );
}

/** Bounded replay-cache defaults; see `createRealtimeCryptoCodec`. */
export const DEFAULT_REPLAY_CACHE_ENTRIES = 4_096;
export const DEFAULT_REPLAY_CACHE_TTL_MS = 60_000;

/**
 * Purposes a room key may be stretched into. Realtime frames, durable
 * snapshots and binary assets each get their own derived key, so the same room
 * key can serve all three without any of them sharing key material.
 */
export const ROOM_KEY_PURPOSES = ["realtime", "snapshot", "asset"] as const;
export type RoomKeyPurpose = (typeof ROOM_KEY_PURPOSES)[number];

/** Unpadded base64url of exactly `ROOM_KEY_BYTES` bytes. */
const ROOM_KEY_LENGTH = Math.ceil((ROOM_KEY_BYTES * 4) / 3);

export const roomKeySchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${ROOM_KEY_LENGTH}}$`))
  .brand<"RoomKey">();
export type RoomKey = z.infer<typeof roomKeySchema>;

const encoder = new TextEncoder();

/**
 * Web Crypto's `BufferSource` excludes `SharedArrayBuffer`-backed views, which
 * TypeScript cannot prove for a plain `Uint8Array`. Every view handed to Web
 * Crypto here comes from `new Uint8Array`, `TextEncoder`, or a WebSocket frame,
 * never from shared memory, so the narrowing is sound — and it stays in this
 * single place rather than spreading `Uint8Array<ArrayBuffer>` through the
 * protocol codec's public types.
 */
const asBufferSource = (view: Uint8Array): BufferSource => view as BufferSource;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const HEX_BY_BYTE = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX_BY_BYTE[byte];
  }
  return hex;
};

/**
 * Generates a fresh room key. This is the only place room key material is
 * created, and it is created on the client: no server, log, or database ever
 * sees it.
 */
export function generateRoomKey(): RoomKey {
  const bytes = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return roomKeySchema.parse(toBase64Url(bytes));
}

/**
 * Stretches a room key into one purpose-bound AES-GCM key. The result is
 * non-extractable, so the derived key cannot be serialized into a log, an
 * error payload, or storage even by accident.
 */
export async function deriveRoomKey(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  /** The app's durable authorization generation, not the relay session epoch. */
  authGeneration: number;
  purpose: RoomKeyPurpose;
}): Promise<CryptoKey> {
  const generation = roomAuthGenerationSchema.parse(options.authGeneration);
  const material = await crypto.subtle.importKey(
    "raw",
    asBufferSource(fromBase64Url(roomKeySchema.parse(options.roomKey))),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Room identity and generation: rotating the generation is a new key.
      salt: asBufferSource(
        encoder.encode(`drawstuff-room/${options.roomId}/g${generation}`),
      ),
      // Envelope version, wire protocol version, and purpose.
      info: asBufferSource(
        encoder.encode(
          `drawstuff-key/v${REALTIME_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${options.purpose}`,
        ),
      ),
    },
    material,
    DERIVED_KEY_BITS,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export type RealtimeCryptoError =
  /**
   * This sender's share of the key's message budget is spent. Continuing would
   * push the room past the collision bound, so sealing stops instead; the room
   * generation must be rotated for a fresh key.
   */
  | { code: "key-budget-exhausted" }
  /** Not a well-formed sealed frame: too short to hold a header and a tag. */
  | { code: "malformed-sealed-frame"; detail: string }
  | { code: "unknown-crypto-version"; receivedVersion: number | undefined }
  /** Wrong key, tampered ciphertext/IV, or mismatched authenticated data. */
  | { code: "authentication-failed" }
  | { code: "replayed-frame" };

export type SealResult =
  { ok: true; frame: Uint8Array } | { ok: false; error: RealtimeCryptoError };

export type OpenResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; error: RealtimeCryptoError };

/** Versioned realtime codec: one instance per transport. */
export interface RealtimeCryptoCodec {
  /**
   * Synchronous capacity check. `seal` charges the budget before its first
   * `await`, so a caller that checks this immediately before calling `seal`
   * cannot be raced by another send.
   */
  canSeal(): boolean;
  /** Messages this codec has sealed under the current derived key. */
  sealedMessageCount(): number;
  seal(plaintext: Uint8Array, channel: MessageChannel): Promise<SealResult>;
  open(frame: Uint8Array, channel: MessageChannel): Promise<OpenResult>;
  /** Live replay-cache size; never exceeds the configured entry cap. */
  replayCacheSize(): number;
}

export type RealtimeCryptoCodecOptions = {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
  /**
   * Lowers this sender's message budget below the derived limit. Exists so the
   * exhaustion path is reachable in tests and so an operator can set a stricter
   * threshold; the default is `MAX_SEALED_MESSAGES_PER_SENDER`.
   */
  maxSealedMessages?: number;
  /** Replay-cache entry cap; the cache never grows past it. */
  maxReplayEntries?: number;
  /** Replay-cache retention window. */
  replayTtlMs?: number;
  now?: () => number;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
};

/**
 * Builds the realtime codec for one room generation.
 *
 * Replay defence is layered. The replay cache rejects a re-delivered IV
 * cheaply, but it is deliberately bounded in both entries and age so an
 * attacker cannot grow client memory by replaying frames with unique IVs.
 * Eviction is safe because `createInboundMessageGate` independently rejects
 * duplicate and stale sequences per sender session: a replay old enough to have
 * been evicted here is still refused there.
 *
 * Only frames that already authenticated enter the cache, so forged frames with
 * fresh IVs cannot evict real entries.
 */
export async function createRealtimeCryptoCodec(
  options: RealtimeCryptoCodecOptions,
): Promise<RealtimeCryptoCodec> {
  const {
    roomId,
    maxSealedMessages = MAX_SEALED_MESSAGES_PER_SENDER,
    maxReplayEntries = DEFAULT_REPLAY_CACHE_ENTRIES,
    replayTtlMs = DEFAULT_REPLAY_CACHE_TTL_MS,
    now = Date.now,
    randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length)),
  } = options;

  if (
    !Number.isSafeInteger(maxSealedMessages) ||
    maxSealedMessages <= 0 ||
    maxSealedMessages > MAX_SEALED_MESSAGES_PER_SENDER
  ) {
    throw new Error(
      `maxSealedMessages must be between 1 and ${MAX_SEALED_MESSAGES_PER_SENDER}, received ${maxSealedMessages}`,
    );
  }
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries <= 0) {
    throw new Error(
      `maxReplayEntries must be a positive integer, received ${maxReplayEntries}`,
    );
  }

  const key = await deriveRoomKey({
    roomKey: options.roomKey,
    roomId,
    authGeneration: options.authGeneration,
    purpose: "realtime",
  });

  /**
   * Authenticated metadata. Every field a receiver can establish without
   * decrypting is bound to the ciphertext: envelope version, wire protocol
   * version, room id, and the message kind (the wire channel). A frame moved to
   * another channel or another room therefore fails authentication instead of
   * decrypting into a message the receiver would misroute.
   */
  const additionalDataFor = (channel: MessageChannel): BufferSource =>
    asBufferSource(
      encoder.encode(
        `drawstuff-realtime/v${REALTIME_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${roomId}/${channel}`,
      ),
    );
  const additionalData: Record<MessageChannel, BufferSource> = {
    scene: additionalDataFor("scene"),
    presence: additionalDataFor("presence"),
  };

  let sealedCount = 0;

  /** Insertion-ordered; the oldest entry is always the first one. */
  const seenIvs = new Map<string, number>();

  const pruneReplayCache = (timestamp: number): void => {
    for (const [ivKey, insertedAt] of seenIvs) {
      if (timestamp - insertedAt <= replayTtlMs) break;
      seenIvs.delete(ivKey);
    }
    while (seenIvs.size >= maxReplayEntries) {
      const oldest = seenIvs.keys().next();
      if (oldest.done) break;
      seenIvs.delete(oldest.value);
    }
  };

  return {
    canSeal: () => sealedCount < maxSealedMessages,
    sealedMessageCount: () => sealedCount,

    async seal(plaintext, channel) {
      // Charged before the first await, so overlapping seals cannot both slip
      // past the final message of the budget.
      if (sealedCount >= maxSealedMessages) {
        return { ok: false, error: { code: "key-budget-exhausted" } };
      }
      sealedCount += 1;

      const iv = randomBytes(REALTIME_NONCE_BYTES);
      if (iv.byteLength !== REALTIME_NONCE_BYTES) {
        throw new Error(
          `randomBytes must return ${REALTIME_NONCE_BYTES} bytes, received ${iv.byteLength}`,
        );
      }
      let sealed: ArrayBuffer;
      try {
        sealed = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(iv),
            additionalData: additionalData[channel],
          },
          key,
          asBufferSource(plaintext),
        );
      } catch (error) {
        // The error name, not the key or the plaintext: nothing secret may reach
        // a caller that might log this.
        return {
          ok: false,
          error: {
            code: "malformed-sealed-frame",
            detail: error instanceof Error ? error.name : "Encryption failed",
          },
        };
      }
      const frame = new Uint8Array(
        REALTIME_SEALED_HEADER_BYTES + sealed.byteLength,
      );
      frame[0] = REALTIME_CRYPTO_VERSION;
      frame.set(iv, VERSION_BYTES);
      frame.set(new Uint8Array(sealed), REALTIME_SEALED_HEADER_BYTES);
      return { ok: true, frame };
    },

    async open(frame, channel) {
      if (frame.byteLength < MIN_REALTIME_SEALED_FRAME_BYTES) {
        return {
          ok: false,
          error: {
            code: "malformed-sealed-frame",
            detail: `Sealed frame must be at least ${MIN_REALTIME_SEALED_FRAME_BYTES} bytes, received ${frame.byteLength}`,
          },
        };
      }
      const receivedVersion = frame[0];
      if (receivedVersion !== REALTIME_CRYPTO_VERSION) {
        return {
          ok: false,
          error: { code: "unknown-crypto-version", receivedVersion },
        };
      }
      const iv = frame.subarray(VERSION_BYTES, REALTIME_SEALED_HEADER_BYTES);
      let opened: ArrayBuffer;
      try {
        opened = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(iv),
            additionalData: additionalData[channel],
          },
          key,
          asBufferSource(frame.subarray(REALTIME_SEALED_HEADER_BYTES)),
        );
      } catch {
        // A wrong key, a flipped ciphertext bit, an altered IV and a channel
        // mismatch are all the same answer: this frame is not from an
        // authorized sender.
        return { ok: false, error: { code: "authentication-failed" } };
      }
      // Checked after authentication and in the same synchronous step as the
      // insert, so two copies of one frame decrypting concurrently still leave
      // exactly one of them accepted.
      const ivKey = toHex(iv);
      if (seenIvs.has(ivKey)) {
        return { ok: false, error: { code: "replayed-frame" } };
      }
      const timestamp = now();
      pruneReplayCache(timestamp);
      seenIvs.set(ivKey, timestamp);
      return { ok: true, plaintext: new Uint8Array(opened) };
    },

    replayCacheSize: () => seenIvs.size,
  };
}
