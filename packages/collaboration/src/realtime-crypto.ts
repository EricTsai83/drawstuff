import { z } from "zod";

import { decodeBase64Url, encodeBase64Url } from "./base64.ts";
import type { MessageChannel } from "./codec.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  maxMessageBytesFor,
  type RoomId,
} from "./messages.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";
import {
  asBufferSource,
  defaultRandomBytes,
  openEnvelope,
  SEALED_ENVELOPE_HEADER_BYTES,
  SEALED_ENVELOPE_IV_BYTES,
  SEALED_ENVELOPE_OVERHEAD_BYTES,
  SEALED_ENVELOPE_TAG_BYTES,
  sealEnvelope,
  toHex,
  utf8AdditionalData,
  utf8Encoder,
} from "./sealed-envelope.ts";

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
 * two separations:
 *
 * - Realtime traffic, durable snapshots, binary assets and the room key-check
 *   value use different purposes, so one leaked derived key never unlocks the
 *   others.
 * - A room's authorization generation is part of the salt, so rotating it
 *   (`collaborationRoom.rotateGeneration`) produces a key that cannot open the
 *   previous generation's ciphertext.
 *
 * Those are the only two inputs. Envelope and protocol versions stay out of the
 * derivation and bind to the ciphertext as authenticated data instead, so a
 * format revision cannot re-derive a live room's keys — see
 * `roomKeyDerivationInfo`.
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
export const REALTIME_NONCE_BYTES = SEALED_ENVELOPE_IV_BYTES;

/** AES-GCM authentication tag length appended to every ciphertext. */
export const AES_GCM_TAG_BYTES = SEALED_ENVELOPE_TAG_BYTES;

/**
 * Sealed frame layout — the shared sealed-envelope shape
 * (`./sealed-envelope.ts`): fixed size, no variable fields.
 */
export const REALTIME_SEALED_HEADER_BYTES = SEALED_ENVELOPE_HEADER_BYTES;

/** Bytes a sealed frame adds to its plaintext: header plus GCM tag. */
export const REALTIME_SEALED_OVERHEAD_BYTES = SEALED_ENVELOPE_OVERHEAD_BYTES;

/** Smallest byte length that could still be a sealed frame. */
export const MIN_REALTIME_SEALED_FRAME_BYTES =
  REALTIME_SEALED_OVERHEAD_BYTES + 1;

export function sealedFrameByteLength(plaintextByteLength: number): number {
  return plaintextByteLength + REALTIME_SEALED_OVERHEAD_BYTES;
}

/**
 * Largest sealed frame this channel can legitimately carry: the channel's
 * plaintext budget plus sealing overhead. Enforced by `open` so the ceiling is
 * this module's own contract rather than an implicit dependency on the relay's
 * transport-level frame cap, which enforces the same arithmetic one header
 * byte higher (`maxRelayDataFrameBytesFor`).
 */
export function maxSealedFrameBytesFor(channel: MessageChannel): number {
  return maxMessageBytesFor(channel) + REALTIME_SEALED_OVERHEAD_BYTES;
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
 * snapshots, binary assets and the room's key-check value each get their own
 * derived key, so the same room key can serve all four without any of them
 * sharing key material.
 */
export const ROOM_KEY_PURPOSES = [
  "realtime",
  "snapshot",
  "asset",
  "keycheck",
] as const;
export type RoomKeyPurpose = (typeof ROOM_KEY_PURPOSES)[number];

/**
 * HKDF `info` for one purpose — the whole derivation label, and deliberately
 * version-free.
 *
 * Envelope and protocol versions describe a *wire format*, so they belong in the
 * authenticated data of each format (`drawstuff-realtime/…`,
 * `drawstuff-snapshot/…`, `drawstuff-asset/…`), where a frame from another
 * version fails authentication. They used to be in this info string as well,
 * which made every derived key a function of them: bumping the realtime envelope
 * would have silently re-derived the `snapshot` and `asset` keys too, making a
 * live room's stored ciphertext permanently unreadable even though its format
 * had not changed.
 *
 * Key rotation therefore has exactly one trigger: the room's authorization
 * generation, which is in the salt.
 *
 * Exported so the "no version reaches the KDF" property is a pinned contract
 * rather than a comment.
 */
export function roomKeyDerivationInfo(purpose: RoomKeyPurpose): string {
  return `drawstuff-key/${purpose}`;
}

/** Unpadded base64url of exactly `ROOM_KEY_BYTES` bytes. */
const ROOM_KEY_LENGTH = Math.ceil((ROOM_KEY_BYTES * 4) / 3);

/**
 * Canonicality is part of the schema, not just the alphabet: a 43-character
 * string whose unused trailing bits are non-zero is not something
 * `generateRoomKey` can produce, and the strict shared codec would refuse it
 * later anyway — refusing it at the parse boundary makes "a RoomKey decodes"
 * an invariant of the brand instead of a runtime surprise.
 */
export const roomKeySchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${ROOM_KEY_LENGTH}}$`))
  .refine(
    (value) => decodeBase64Url(value, { maxBytes: ROOM_KEY_BYTES }).ok,
    "Room key must be canonical unpadded base64url",
  )
  .brand<"RoomKey">();
export type RoomKey = z.infer<typeof roomKeySchema>;

const encoder = utf8Encoder;

/**
 * Generates a fresh room key. This is the only place room key material is
 * created, and it is created on the client: no server, log, or database ever
 * sees it.
 */
export function generateRoomKey(): RoomKey {
  const bytes = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return roomKeySchema.parse(encodeBase64Url(bytes));
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
  const decodedRoomKey = decodeBase64Url(roomKeySchema.parse(options.roomKey), {
    maxBytes: ROOM_KEY_BYTES,
  });
  // Unreachable for a parsed RoomKey — the schema refines on this very decode
  // — so a failure here is a defect, not untrusted input.
  if (!decodedRoomKey.ok) {
    throw new Error("Room key is not canonical unpadded base64url");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    asBufferSource(decodedRoomKey.bytes),
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
      // Purpose only. No envelope or protocol version participates here — see
      // `roomKeyDerivationInfo`.
      info: asBufferSource(
        encoder.encode(roomKeyDerivationInfo(options.purpose)),
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
    randomBytes = defaultRandomBytes,
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
    utf8AdditionalData(
      `drawstuff-realtime/v${REALTIME_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${roomId}/${channel}`,
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

      const sealed = await sealEnvelope({
        version: REALTIME_CRYPTO_VERSION,
        key,
        plaintext,
        additionalData: additionalData[channel],
        randomBytes,
      });
      if (!sealed.ok) {
        // The error name, not the key or the plaintext: nothing secret may
        // reach a caller that might log this.
        return {
          ok: false,
          error: {
            code: "malformed-sealed-frame",
            detail: sealed.failure.errorName,
          },
        };
      }
      return { ok: true, frame: sealed.ciphertext };
    },

    async open(frame, channel) {
      const opened = await openEnvelope({
        version: REALTIME_CRYPTO_VERSION,
        key,
        ciphertext: frame,
        additionalData: additionalData[channel],
        minCiphertextBytes: MIN_REALTIME_SEALED_FRAME_BYTES,
        maxCiphertextBytes: maxSealedFrameBytesFor(channel),
      });
      if (!opened.ok) {
        const { failure } = opened;
        switch (failure.code) {
          case "below-min-size":
            return {
              ok: false,
              error: {
                code: "malformed-sealed-frame",
                detail: `Sealed frame must be at least ${failure.minByteLength} bytes, received ${failure.receivedByteLength}`,
              },
            };
          case "above-max-size":
            return {
              ok: false,
              error: {
                code: "malformed-sealed-frame",
                detail: `Sealed frame must be at most ${failure.maxByteLength} bytes on the ${channel} channel, received ${failure.receivedByteLength}`,
              },
            };
          case "unknown-version":
            return {
              ok: false,
              error: {
                code: "unknown-crypto-version",
                receivedVersion: failure.receivedVersion,
              },
            };
          case "authentication-failed":
            // A wrong key, a flipped ciphertext bit, an altered IV and a
            // channel mismatch are all the same answer: this frame is not
            // from an authorized sender.
            return { ok: false, error: { code: "authentication-failed" } };
        }
      }
      // Checked after authentication and in the same synchronous step as the
      // insert, so two copies of one frame decrypting concurrently still leave
      // exactly one of them accepted.
      const ivKey = toHex(opened.iv);
      if (seenIvs.has(ivKey)) {
        return { ok: false, error: { code: "replayed-frame" } };
      }
      const timestamp = now();
      pruneReplayCache(timestamp);
      seenIvs.set(ivKey, timestamp);
      return { ok: true, plaintext: opened.plaintext };
    },

    replayCacheSize: () => seenIvs.size,
  };
}
