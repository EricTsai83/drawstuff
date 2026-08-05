import { MAX_SCENE_MESSAGE_BYTES, type SyncedElement } from "./messages.ts";

/**
 * Bounded accounting of the local edits made while a session is not live.
 *
 * A client keeps drawing through a disconnect and through the join window that
 * follows it, and those edits have to reach the room afterwards. The naive
 * version of that is a log of every `onChange`, which is an unbounded buffer
 * filled by the user's own hand — a minute of freehand drawing is thousands of
 * entries describing a few dozen elements.
 *
 * So nothing is logged. Elements are coalesced by id, keeping the newest
 * version, and the queue stores identity and size only — the element bodies stay
 * where they already are, in the scene. That has a second benefit beyond memory:
 * the reconnect flush re-reads the scene, so an element created and then deleted
 * while offline is sent as the tombstone it now is, rather than resurrected from
 * a stale queue entry.
 *
 * The queue is bounded three ways, and exceeding any of them does not fail the
 * reconnect: the accounting is dropped and the verdict becomes one full-scene
 * sync. That degradation is the point — a full sync is a fixed, bounded cost that
 * converges from any starting state, so the queue never has to be right about
 * more than "is a delta still the cheap answer".
 *
 * - **Count**: past a few thousand distinct elements a delta is no longer cheaper
 *   than the snapshot it is trying to avoid.
 * - **Bytes**: the eventual delta has to fit one scene message, and a queue that
 *   already exceeds that budget cannot be sent at all.
 * - **Age**: room membership churns. After a long absence the peers that knew
 *   what this client had sent may all be gone, and what they know is exactly what
 *   a delta assumes.
 */

/** Distinct offline-changed elements before a delta stops being worthwhile. */
export const DEFAULT_OFFLINE_QUEUE_MAX_ELEMENTS = 2_048;

/**
 * Byte budget for the accumulated delta, measured as the elements' encoded size.
 * Half a scene message, which leaves room for the envelope and for elements that
 * grew after they were measured; a delta that cannot fit one message is a delta
 * that cannot be sent, so degrading before the codec refuses it is the point.
 */
export const DEFAULT_OFFLINE_QUEUE_MAX_BYTES = MAX_SCENE_MESSAGE_BYTES / 2;

/**
 * How long offline edits stay eligible for delta replay. Beyond it the room's
 * membership is assumed to have turned over, so a full sync is the honest answer.
 */
export const DEFAULT_OFFLINE_QUEUE_MAX_AGE_MS = 5 * 60_000;

/** Which bound was exceeded; reported so the degradation is never silent. */
export type OfflineFullSyncReason =
  "element-limit" | "byte-limit" | "age-limit";

export type OfflineFlushVerdict =
  /** Nothing changed while the session was down. */
  | { readonly mode: "none" }
  /**
   * Send the pending local changes as a delta. The elements themselves come from
   * the scene, not from here; `elementCount` is what was accounted for.
   */
  | { readonly mode: "delta"; readonly elementCount: number }
  /** Send one full-scene snapshot instead. */
  | { readonly mode: "full-sync"; readonly reason: OfflineFullSyncReason };

export type OfflineChangeQueueOptions = {
  maxElements?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  /**
   * Encoded size of one element. Injectable so a caller that already knows the
   * wire size does not pay for it twice; the default measures the same JSON and
   * UTF-8 encoding the protocol codec uses, so the byte budget is in wire bytes
   * rather than in an approximation of them.
   */
  measureBytes?: (element: SyncedElement) => number;
};

export interface OfflineChangeQueue {
  /**
   * Accounts for local changes observed while the session is not live.
   *
   * Idempotent per (id, version): re-recording an element the queue already
   * holds at that version costs nothing and measures nothing, which is what
   * makes calling this on every coalesced flush affordable — the flush keeps
   * re-extracting the same pending elements until they are actually sent.
   */
  record(elements: readonly SyncedElement[], at: number): void;
  pendingElementCount(): number;
  pendingByteLength(): number;
  /** Set once a bound was exceeded; cleared only by `drain` or `clear`. */
  fullSyncReason(): OfflineFullSyncReason | undefined;
  /**
   * Reports what the reconnect should send and resets the accounting. Takes the
   * current time because the age bound is only meaningful at the moment the
   * decision is made — a session can sit disconnected without recording
   * anything.
   */
  drain(at: number): OfflineFlushVerdict;
  /** Forgets everything, including a tripped bound. */
  clear(): void;
}

const encoder = new TextEncoder();

/**
 * Encoded size of one element, in the same JSON/UTF-8 form the protocol codec
 * puts on the wire.
 */
export function encodedElementByteLength(element: SyncedElement): number {
  try {
    return encoder.encode(JSON.stringify(element)).byteLength;
  } catch {
    // An element the codec could not encode either. Charged at the byte budget
    // so it trips the bound instead of being counted as free.
    return DEFAULT_OFFLINE_QUEUE_MAX_BYTES;
  }
}

export function createOfflineChangeQueue(
  options: OfflineChangeQueueOptions = {},
): OfflineChangeQueue {
  const {
    maxElements = DEFAULT_OFFLINE_QUEUE_MAX_ELEMENTS,
    maxBytes = DEFAULT_OFFLINE_QUEUE_MAX_BYTES,
    maxAgeMs = DEFAULT_OFFLINE_QUEUE_MAX_AGE_MS,
    measureBytes = encodedElementByteLength,
  } = options;
  for (const [name, value] of [
    ["maxElements", maxElements],
    ["maxBytes", maxBytes],
    ["maxAgeMs", maxAgeMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, received ${value}`);
    }
  }

  type Entry = { version: number; versionNonce: number; byteLength: number };
  let entries = new Map<string, Entry>();
  let pendingBytes = 0;
  let firstRecordedAt: number | undefined;
  let fullSync: OfflineFullSyncReason | undefined;

  const degrade = (reason: OfflineFullSyncReason): void => {
    fullSync = reason;
    // The accounting has served its purpose: a full sync needs no per-element
    // detail, and keeping the map would keep the memory the bound exists to cap.
    entries = new Map();
    pendingBytes = 0;
  };

  const reset = (): void => {
    entries = new Map();
    pendingBytes = 0;
    firstRecordedAt = undefined;
    fullSync = undefined;
  };

  return {
    record(elements, at) {
      // Already degraded: there is nothing a further measurement could change.
      if (fullSync) return;
      if (elements.length === 0) return;
      firstRecordedAt ??= at;
      if (at - firstRecordedAt > maxAgeMs) {
        degrade("age-limit");
        return;
      }

      for (const element of elements) {
        const existing = entries.get(element.id);
        if (existing) {
          // Coalesce by id: the newest version wins, an equal version with a
          // different nonce is a different edit and is re-measured, and the
          // element exactly as already held costs nothing. That last case is the
          // common one — a blocked flush re-extracts the same pending elements
          // every frame — so it must not measure anything.
          if (existing.version > element.version) continue;
          if (
            existing.version === element.version &&
            existing.versionNonce === element.versionNonce
          ) {
            continue;
          }
        }
        const byteLength = measureBytes(element);
        pendingBytes += byteLength - (existing?.byteLength ?? 0);
        entries.set(element.id, {
          version: element.version,
          versionNonce: element.versionNonce,
          byteLength,
        });
        if (entries.size > maxElements) {
          degrade("element-limit");
          return;
        }
        if (pendingBytes > maxBytes) {
          degrade("byte-limit");
          return;
        }
      }
    },

    pendingElementCount: () => entries.size,
    pendingByteLength: () => pendingBytes,
    fullSyncReason: () => fullSync,

    drain(at) {
      const tripped = fullSync;
      const aged =
        firstRecordedAt !== undefined && at - firstRecordedAt > maxAgeMs;
      const count = entries.size;
      reset();
      if (tripped) return { mode: "full-sync", reason: tripped };
      if (aged) return { mode: "full-sync", reason: "age-limit" };
      if (count === 0) return { mode: "none" };
      return { mode: "delta", elementCount: count };
    },

    clear: reset,
  };
}
