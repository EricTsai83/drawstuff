import { z } from "zod";

import {
  roomIdSchema,
  syncedElementSchema,
  type RoomId,
  type SyncedElement,
} from "./messages.ts";
import {
  AES_GCM_TAG_BYTES,
  deriveRoomKey,
  REALTIME_NONCE_BYTES,
  type RoomKey,
} from "./realtime-crypto.ts";
import { roomAuthGenerationSchema, roomRoleCanEditScene } from "./room-auth.ts";
import type { RoomPeer } from "./transport.ts";

/**
 * Durable collaboration snapshot: the room's own baseline, independent of
 * whether anybody is connected.
 *
 * A room that empties out, or a relay that restarts, loses every in-memory copy
 * of the scene — the relay is stateless by design and holds no durable scene
 * state (ADR 0001). The snapshot is what a later joiner recovers from, and it is
 * deliberately a *separate lifecycle* from the owned-scene V4 document: the
 * owner's saved scene is written by the owner on save, this is written by
 * whichever participant is elected to, and neither ever overwrites the other.
 *
 * Two properties make the storage side uninteresting to attack:
 *
 * - The server stores an opaque byte string. Sealing happens here, in the
 *   browser, under a key derived from the room key with purpose `snapshot`, so
 *   the snapshot key is not the realtime key and neither one unlocks the other.
 * - The metadata the server does see — crypto version, revision, byte length,
 *   ciphertext checksum — says nothing about the scene. The checksum is over
 *   *ciphertext*, so it cannot be used to confirm a guessed plaintext.
 *
 * What a snapshot contains is also narrower than what the realtime channel
 * carries: syncable elements only. Presence, viewport, selection, theme and the
 * collaborator list are session state and must never become durable room state.
 * `collaborationSnapshotSchema` is a strict object, so a future field can only
 * enter it deliberately.
 */

export const COLLABORATION_SNAPSHOT_PROFILE = "collaboration-snapshot";

/** Snapshot document version; bumped only on a breaking payload change. */
export const COLLABORATION_SNAPSHOT_VERSION = 1;

/**
 * Sealed snapshot envelope version. Independent from
 * `REALTIME_CRYPTO_VERSION`: the two formats are sealed under different derived
 * keys and evolve separately, so sharing a version number would couple them for
 * no reason.
 */
export const SNAPSHOT_CRYPTO_VERSION = 1;

const VERSION_BYTES = 1;

/**
 * Sealed snapshot layout — same shape as a realtime frame, and for the same
 * reason: fixed size, no variable fields, no sender identity.
 *
 * ```
 * 0                  envelope version
 * 1 .. 13            random IV
 * rest               AES-GCM ciphertext ‖ tag
 * ```
 */
export const SNAPSHOT_SEALED_HEADER_BYTES =
  VERSION_BYTES + REALTIME_NONCE_BYTES;

export const SNAPSHOT_SEALED_OVERHEAD_BYTES =
  SNAPSHOT_SEALED_HEADER_BYTES + AES_GCM_TAG_BYTES;

export const MIN_SNAPSHOT_SEALED_BYTES = SNAPSHOT_SEALED_OVERHEAD_BYTES + 1;

/**
 * Plaintext ceiling for one snapshot. Larger than a realtime scene message
 * (`MAX_SCENE_MESSAGE_BYTES`) because a snapshot is a whole scene rather than a
 * delta, and bounded because the server has to accept it sight unseen: an
 * unbounded ciphertext column is a way for an authorized member to grow the
 * database without limit.
 */
export const MAX_SNAPSHOT_PLAINTEXT_BYTES = 4 * 1_048_576;

/** Wire/storage ceiling: the plaintext budget plus sealing overhead. */
export const MAX_SNAPSHOT_CIPHERTEXT_BYTES =
  MAX_SNAPSHOT_PLAINTEXT_BYTES + SNAPSHOT_SEALED_OVERHEAD_BYTES;

/**
 * Snapshot revisions start at 1 and advance by one per accepted write. A writer
 * states the revision it believes is current; the store accepts the write only
 * if that is still true, which is what stops a writer holding a stale scene
 * from overwriting a newer snapshot.
 */
export const SNAPSHOT_REVISION_START = 1;
export const snapshotRevisionSchema = z.int().positive();

/**
 * Sentinel a writer passes when it believes no snapshot exists yet. Not a
 * revision: `snapshotRevisionSchema` rejects it, so it can only ever arrive
 * through the field that expects it.
 */
export const SNAPSHOT_NO_REVISION = 0;
export const expectedSnapshotRevisionSchema = z.union([
  z.literal(SNAPSHOT_NO_REVISION),
  snapshotRevisionSchema,
]);

/** SHA-256 hex; the checksum the store keeps over the sealed bytes. */
export const snapshotChecksumSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Keys that must never appear in a snapshot payload. The schema is strict, so
 * these are already rejected; the list exists so the contract test asserts the
 * *intent* rather than only the current field set.
 */
export const FORBIDDEN_SNAPSHOT_KEYS = [
  "appState",
  "collaborators",
  "presence",
  "viewport",
  "files",
] as const;

export const collaborationSnapshotSchema = z.strictObject({
  profile: z.literal(COLLABORATION_SNAPSHOT_PROFILE),
  snapshotVersion: z.literal(COLLABORATION_SNAPSHOT_VERSION),
  roomId: roomIdSchema,
  /**
   * Syncable elements only, in scene order, with the same validation the
   * realtime channel applies: identity fields pinned, element bodies passed
   * through unprojected, embedded binary asset data refused.
   */
  elements: z.array(syncedElementSchema),
});
export type CollaborationSnapshot = z.infer<typeof collaborationSnapshotSchema>;

export type SnapshotCodecError =
  | { code: "oversize-snapshot"; byteLength: number; maxByteLength: number }
  | { code: "malformed-snapshot"; detail: string }
  | {
      code: "unknown-snapshot-version";
      receivedVersion: number | undefined;
    }
  /** Decoded cleanly, but for a different room than the reader is in. */
  | { code: "wrong-room"; receivedRoomId: string };

export type EncodeSnapshotResult =
  { ok: true; bytes: Uint8Array } | { ok: false; error: SnapshotCodecError };

export type DecodeSnapshotResult =
  | { ok: true; snapshot: CollaborationSnapshot }
  | { ok: false; error: SnapshotCodecError };

const encoder = new TextEncoder();
// Fatal so malformed UTF-8 is refused rather than repaired into a different
// (possibly valid) snapshot via U+FFFD replacement.
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Web Crypto's `BufferSource` excludes `SharedArrayBuffer`-backed views, which
 * TypeScript cannot prove for a plain `Uint8Array`. Every view here comes from
 * `new Uint8Array` or `TextEncoder`, never from shared memory.
 */
const asBufferSource = (view: Uint8Array): BufferSource => view as BufferSource;

const HEX_BY_BYTE = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) hex += HEX_BY_BYTE[byte];
  return hex;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", asBufferSource(bytes));
  return toHex(new Uint8Array(digest));
};

export function encodeCollaborationSnapshot(input: {
  roomId: RoomId;
  elements: readonly SyncedElement[];
}): EncodeSnapshotResult {
  const parsed = collaborationSnapshotSchema.safeParse({
    profile: COLLABORATION_SNAPSHOT_PROFILE,
    snapshotVersion: COLLABORATION_SNAPSHOT_VERSION,
    roomId: input.roomId,
    elements: input.elements,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: z.prettifyError(parsed.error),
      },
    };
  }

  let bytes: Uint8Array;
  try {
    // Element bodies pass validation unprojected, so a non-serializable value
    // (bigint, circular reference) surfaces here rather than on the wire.
    bytes = encoder.encode(JSON.stringify(parsed.data));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail:
          error instanceof Error ? error.message : "Unserializable snapshot",
      },
    };
  }
  if (bytes.byteLength > MAX_SNAPSHOT_PLAINTEXT_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-snapshot",
        byteLength: bytes.byteLength,
        maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
      },
    };
  }
  return { ok: true, bytes };
}

export function decodeCollaborationSnapshot(
  bytes: Uint8Array,
  expected: { roomId: RoomId },
): DecodeSnapshotResult {
  // Bounded before parsing: oversize input is never decoded, whatever it holds.
  if (bytes.byteLength > MAX_SNAPSHOT_PLAINTEXT_BYTES) {
    return {
      ok: false,
      error: {
        code: "oversize-snapshot",
        byteLength: bytes.byteLength,
        maxByteLength: MAX_SNAPSHOT_PLAINTEXT_BYTES,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: error instanceof Error ? error.message : "Invalid JSON",
      },
    };
  }

  const receivedVersion =
    typeof raw === "object" && raw !== null && "snapshotVersion" in raw
      ? raw.snapshotVersion
      : undefined;
  if (receivedVersion !== COLLABORATION_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: {
        code: "unknown-snapshot-version",
        receivedVersion:
          typeof receivedVersion === "number" ? receivedVersion : undefined,
      },
    };
  }

  const parsed = collaborationSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "malformed-snapshot",
        detail: z.prettifyError(parsed.error),
      },
    };
  }
  // The seal already binds the room id, so this can only fail on a snapshot
  // sealed for another room under the same key material — impossible today, and
  // still refused rather than applied to the wrong canvas.
  if (parsed.data.roomId !== expected.roomId) {
    return {
      ok: false,
      error: { code: "wrong-room", receivedRoomId: parsed.data.roomId },
    };
  }
  return { ok: true, snapshot: parsed.data };
}

/**
 * Semantic digest of a snapshot's element set: the identity triple
 * reconciliation converges on, in a canonical order.
 *
 * Two clients that converged produce the same digest even though their scene
 * arrays may differ in object identity, and a scene recovered from a snapshot
 * produces the same digest as the scene it was taken from. Used by the session
 * to skip a redundant snapshot write, and by tests as the convergence oracle.
 */
export async function collaborationSnapshotDigest(
  elements: readonly SyncedElement[],
): Promise<string> {
  const canonical = [...elements]
    .map(
      (element) =>
        `${element.id}:${element.version}:${element.versionNonce}:${
          element.isDeleted ? 1 : 0
        }`,
    )
    .sort()
    .join("\n");
  return sha256Hex(encoder.encode(canonical));
}

/** Checksum the store keeps over the sealed bytes; reveals no plaintext. */
export function snapshotCiphertextChecksum(
  ciphertext: Uint8Array,
): Promise<string> {
  return sha256Hex(ciphertext);
}

/**
 * Derives the room's snapshot key. Separate purpose from realtime traffic, so a
 * leaked realtime key cannot open durable snapshots and vice versa, and bound to
 * the authorization generation, so rotating the generation makes every snapshot
 * written under the previous one unreadable.
 */
export function deriveSnapshotKey(options: {
  roomKey: RoomKey;
  roomId: RoomId;
  authGeneration: number;
}): Promise<CryptoKey> {
  return deriveRoomKey({ ...options, purpose: "snapshot" });
}

export type SnapshotCryptoError =
  | { code: "malformed-sealed-snapshot"; detail: string }
  | { code: "unknown-crypto-version"; receivedVersion: number | undefined }
  /** Wrong key, tampered bytes, or metadata that does not match the seal. */
  | { code: "authentication-failed" };

export type SealSnapshotResult =
  | { ok: true; ciphertext: Uint8Array }
  | { ok: false; error: SnapshotCryptoError };

export type OpenSnapshotResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; error: SnapshotCryptoError };

/**
 * Authenticated metadata. Everything the store can see is bound to the
 * ciphertext: envelope version, room, authorization generation and revision.
 * Binding the revision is what stops a store from pairing revision N's bytes
 * with revision M's metadata — it can still serve an older (revision,
 * ciphertext) pair intact, which is the part no client-side check can rule
 * out, but it cannot fabricate a consistent-looking mix.
 *
 * Deliberately free of `COLLABORATION_PROTOCOL_VERSION`: that versions
 * transport messages, and a snapshot is durable state. It used to be bound
 * here as well, which made every stored snapshot unreadable after a purely
 * transport-side protocol bump; the snapshot's own envelope version is the
 * only format version that belongs in this seal.
 *
 * Exported so the "no transport version reaches durable authenticated data"
 * property is a pinned contract rather than a comment.
 */
export function snapshotAdditionalDataLabel(params: {
  roomId: RoomId;
  authGeneration: number;
  revision: number;
}): string {
  return `drawstuff-snapshot/v${SNAPSHOT_CRYPTO_VERSION}/${params.roomId}/g${roomAuthGenerationSchema.parse(
    params.authGeneration,
  )}/r${snapshotRevisionSchema.parse(params.revision)}`;
}

const snapshotAdditionalData = (params: {
  roomId: RoomId;
  authGeneration: number;
  revision: number;
}): BufferSource =>
  asBufferSource(encoder.encode(snapshotAdditionalDataLabel(params)));

export async function sealCollaborationSnapshot(options: {
  key: CryptoKey;
  plaintext: Uint8Array;
  roomId: RoomId;
  authGeneration: number;
  /** Revision this ciphertext will be stored under. */
  revision: number;
  /** Injectable only for deterministic tests; production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
}): Promise<SealSnapshotResult> {
  const randomBytes =
    options.randomBytes ??
    ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
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
        additionalData: snapshotAdditionalData(options),
      },
      options.key,
      asBufferSource(options.plaintext),
    );
  } catch (error) {
    // The error name, never the key or the plaintext: a caller may log this.
    return {
      ok: false,
      error: {
        code: "malformed-sealed-snapshot",
        detail: error instanceof Error ? error.name : "Encryption failed",
      },
    };
  }
  const ciphertext = new Uint8Array(
    SNAPSHOT_SEALED_HEADER_BYTES + sealed.byteLength,
  );
  ciphertext[0] = SNAPSHOT_CRYPTO_VERSION;
  ciphertext.set(iv, VERSION_BYTES);
  ciphertext.set(new Uint8Array(sealed), SNAPSHOT_SEALED_HEADER_BYTES);
  return { ok: true, ciphertext };
}

export async function openCollaborationSnapshot(options: {
  key: CryptoKey;
  ciphertext: Uint8Array;
  roomId: RoomId;
  authGeneration: number;
  revision: number;
}): Promise<OpenSnapshotResult> {
  const { ciphertext } = options;
  if (ciphertext.byteLength < MIN_SNAPSHOT_SEALED_BYTES) {
    return {
      ok: false,
      error: {
        code: "malformed-sealed-snapshot",
        detail: `Sealed snapshot must be at least ${MIN_SNAPSHOT_SEALED_BYTES} bytes, received ${ciphertext.byteLength}`,
      },
    };
  }
  if (ciphertext.byteLength > MAX_SNAPSHOT_CIPHERTEXT_BYTES) {
    return {
      ok: false,
      error: {
        code: "malformed-sealed-snapshot",
        detail: `Sealed snapshot must be at most ${MAX_SNAPSHOT_CIPHERTEXT_BYTES} bytes, received ${ciphertext.byteLength}`,
      },
    };
  }
  const receivedVersion = ciphertext[0];
  if (receivedVersion !== SNAPSHOT_CRYPTO_VERSION) {
    return {
      ok: false,
      error: { code: "unknown-crypto-version", receivedVersion },
    };
  }
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(
          ciphertext.subarray(VERSION_BYTES, SNAPSHOT_SEALED_HEADER_BYTES),
        ),
        additionalData: snapshotAdditionalData(options),
      },
      options.key,
      asBufferSource(ciphertext.subarray(SNAPSHOT_SEALED_HEADER_BYTES)),
    );
    return { ok: true, plaintext: new Uint8Array(opened) };
  } catch {
    // A wrong key, a rotated generation, tampered bytes and mismatched metadata
    // are all the same answer: this is not a snapshot this reader can trust.
    return { ok: false, error: { code: "authentication-failed" } };
  }
}

/**
 * Picks the single participant responsible for writing snapshots.
 *
 * Every member computes this from the membership list the relay broadcast, so
 * they all reach the same answer without a coordination round-trip, and the
 * smallest peer id is a total order that does not depend on join timing. Only a
 * peer that may edit the scene is eligible: a viewer's write would be refused by
 * the server anyway, and electing one would leave the room with no writer at
 * all.
 *
 * Returns `undefined` when the room has no eligible member — a viewers-only
 * room simply keeps whatever snapshot it already had.
 */
export function electSnapshotWriter(
  peers: readonly RoomPeer[],
): RoomPeer | undefined {
  let elected: RoomPeer | undefined;
  for (const peer of peers) {
    if (!roomRoleCanEditScene(peer.role)) continue;
    if (elected === undefined || peer.peerId < elected.peerId) elected = peer;
  }
  return elected;
}
