import { decodeBase64, encodeBase64 } from "@drawstuff/collaboration/base64";
import type { RoomId, SyncedElement } from "@drawstuff/collaboration/protocol";
import type { RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import {
  decodeCollaborationSnapshot,
  deriveSnapshotKey,
  encodeCollaborationSnapshot,
  MAX_SNAPSHOT_CIPHERTEXT_BYTES,
  openCollaborationSnapshot,
  sealCollaborationSnapshot,
  snapshotCiphertextChecksum,
  SNAPSHOT_CRYPTO_VERSION,
  SNAPSHOT_NO_REVISION,
} from "@drawstuff/collaboration/snapshot";

import { rateLimitRetryAfterMs } from "@/lib/collab/rate-limit";

/**
 * Client half of durable snapshot storage: the only place a snapshot is sealed
 * or opened.
 *
 * The split mirrors the realtime one. Authorization comes from the backend (the
 * room API decides who may read or write a baseline); confidentiality comes from
 * the URL fragment (the room key, which never leaves the browser). So this module
 * needs both, and the transport layer below it only ever handles base64
 * ciphertext — there is no code path that could send a readable snapshot, because
 * `save` seals before it calls the API and `load` opens after.
 *
 * Every failure is reported as a typed outcome rather than thrown. A snapshot
 * that cannot be opened is a real, expected state — a link carrying the wrong
 * key, or a generation that was rotated after the link was shared — and the
 * caller has to distinguish it from "this room has no baseline yet": one is a
 * dead end for the session, the other is a perfectly normal empty room.
 */

/** The backend surface this store needs; `api.useUtils().client` satisfies it. */
export type SnapshotApi = {
  get(input: { roomId: string }): Promise<{
    authGeneration: number;
    snapshot: {
      revision: number;
      cryptoVersion: number;
      ciphertextBase64: string;
      byteLength: number;
      checksum: string;
    } | null;
  }>;
  put(input: {
    roomId: string;
    /** Scheduling hint only; the server never treats this as authorization. */
    intent: "cadence" | "leave";
    /** Generation the ciphertext was sealed for; the server refuses a mismatch. */
    authGeneration: number;
    expectedRevision: number;
    cryptoVersion: typeof SNAPSHOT_CRYPTO_VERSION;
    ciphertextBase64: string;
    checksum: string;
  }): Promise<
    | { status: "written"; revision: number }
    | { status: "conflict"; currentRevision: number | undefined }
  >;
};

type LoadSnapshotResult =
  | { status: "loaded"; revision: number; elements: readonly SyncedElement[] }
  /** This room generation has no baseline yet; a fresh room looks like this. */
  | { status: "empty" }
  | {
      status: "unreadable";
      /**
       * `wrong-key` covers a bad key, a rotated generation and tampered bytes
       * alike — AES-GCM cannot tell them apart, and neither should a message
       * shown to a user. `unavailable` is a transport or authorization failure,
       * which a retry could still fix.
       */
      reason: "wrong-key" | "malformed" | "unavailable";
    };

export type SaveSnapshotResult =
  | { status: "written"; revision: number }
  | { status: "conflict"; currentRevision: number | undefined }
  /**
   * The scene is larger than the locked snapshot contract, so nothing was
   * sealed and nothing was sent.
   *
   * Separate from `failed` because the two need opposite handling. A failed
   * write is a transient condition the next cadence tick usually resolves, so
   * ignoring it is correct; an oversize scene will be refused on every tick
   * until the user removes content, so ignoring it is a canvas that silently
   * stops being backed up. A caller that cannot tell them apart has no way to
   * say which one it is.
   */
  | { status: "oversize"; byteLength: number; maxByteLength: number }
  /**
   * The room's shared write budget is spent. Retryable — unlike `oversize` the
   * scene is fine and unlike `failed` the server said exactly when — so it is
   * reported as itself, carrying the deadline the caller must not write before.
   * Folding it into `failed` would leave the caller retrying on its own cadence
   * into a window that has not reset, spending the budget it is waiting for.
   */
  | { status: "rate-limited"; retryAfterMs: number }
  /** Sealing, encoding or the request failed; the caller retries on cadence. */
  | { status: "failed" };

export type CollaborationSnapshotStore = {
  load: () => Promise<LoadSnapshotResult>;
  save: (input: {
    elements: readonly SyncedElement[];
    /** Revision the caller believes is current, or `SNAPSHOT_NO_REVISION`. */
    expectedRevision: number;
    /** A leave flush may use the server's separate bounded finalization reserve. */
    intent?: "cadence" | "leave";
  }) => Promise<SaveSnapshotResult>;
};

export async function createCollaborationSnapshotStore(options: {
  api: SnapshotApi;
  roomId: RoomId;
  /** End-to-end room key from the URL fragment; never from the backend. */
  roomKey: RoomKey;
  /** Authorization generation the session joined under. */
  authGeneration: number;
}): Promise<CollaborationSnapshotStore> {
  const { api, roomId, authGeneration } = options;
  // Derived once per session: the key is bound to (room, generation, purpose),
  // and it is non-extractable, so it cannot end up in a log or an error payload.
  const key = await deriveSnapshotKey({
    roomKey: options.roomKey,
    roomId,
    authGeneration,
  });

  return {
    async load() {
      let response: Awaited<ReturnType<SnapshotApi["get"]>>;
      try {
        response = await api.get({ roomId });
      } catch {
        return { status: "unreadable", reason: "unavailable" };
      }
      const stored = response.snapshot;
      if (!stored) return { status: "empty" };
      // The generation the row belongs to is the one the key was derived for;
      // a mismatch means the room rotated under us and the bytes are not ours
      // to read.
      if (
        response.authGeneration !== authGeneration ||
        stored.cryptoVersion !== SNAPSHOT_CRYPTO_VERSION
      ) {
        return { status: "unreadable", reason: "wrong-key" };
      }

      // Canonical decode via the shared codec (native TypedArray Base64 where
      // the browser has it), bounded by the locked ciphertext contract before
      // any multi-MiB allocation happens.
      const decodedCiphertext = decodeBase64(stored.ciphertextBase64, {
        maxBytes: MAX_SNAPSHOT_CIPHERTEXT_BYTES,
      });
      if (!decodedCiphertext.ok) {
        return { status: "unreadable", reason: "malformed" };
      }
      const ciphertext = decodedCiphertext.bytes;
      if (ciphertext.byteLength !== stored.byteLength) {
        return { status: "unreadable", reason: "malformed" };
      }
      if ((await snapshotCiphertextChecksum(ciphertext)) !== stored.checksum) {
        return { status: "unreadable", reason: "malformed" };
      }

      const opened = await openCollaborationSnapshot({
        key,
        ciphertext,
        roomId,
        authGeneration,
        revision: stored.revision,
      });
      if (!opened.ok) return { status: "unreadable", reason: "wrong-key" };

      const decoded = decodeCollaborationSnapshot(opened.plaintext, { roomId });
      if (!decoded.ok) return { status: "unreadable", reason: "malformed" };
      return {
        status: "loaded",
        revision: stored.revision,
        elements: decoded.snapshot.elements,
      };
    },

    async save({ elements, expectedRevision, intent = "cadence" }) {
      const encoded = encodeCollaborationSnapshot({ roomId, elements });
      if (!encoded.ok) {
        // "Too big" is the one encoding failure the user can act on, and the
        // only one that will still be true on the next tick, so it is reported
        // as itself instead of being folded into the generic failure.
        if (encoded.error.code === "oversize-snapshot") {
          return {
            status: "oversize",
            byteLength: encoded.error.byteLength,
            maxByteLength: encoded.error.maxByteLength,
          };
        }
        return { status: "failed" };
      }
      // The revision the bytes will live at is authenticated into the seal, so
      // it has to be predicted here — which is exactly the revision the
      // conditional write will produce if it wins.
      const revision =
        expectedRevision === SNAPSHOT_NO_REVISION ? 1 : expectedRevision + 1;
      const sealed = await sealCollaborationSnapshot({
        key,
        plaintext: encoded.bytes,
        roomId,
        authGeneration,
        revision,
      });
      if (!sealed.ok) return { status: "failed" };

      try {
        return await api.put({
          roomId,
          intent,
          // Sent so the server stores the ciphertext under the generation it was
          // sealed for, or refuses: a rotation racing this write would otherwise
          // produce a row nobody can open.
          authGeneration,
          expectedRevision,
          cryptoVersion: SNAPSHOT_CRYPTO_VERSION,
          ciphertextBase64: encodeBase64(sealed.ciphertext),
          checksum: await snapshotCiphertextChecksum(sealed.ciphertext),
        });
      } catch (error) {
        const retryAfterMs = rateLimitRetryAfterMs(error);
        if (retryAfterMs !== null)
          return { status: "rate-limited", retryAfterMs };
        return { status: "failed" };
      }
    },
  };
}
