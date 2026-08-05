import { describe, expect, it, vi } from "vitest";

import type { SyncedElement } from "../src/messages.ts";
import {
  createOfflineChangeQueue,
  DEFAULT_OFFLINE_QUEUE_MAX_BYTES,
  encodedElementByteLength,
} from "../src/offline-queue.ts";

const element = (id: string, version = 1, versionNonce = 1): SyncedElement => ({
  id,
  version,
  versionNonce,
  isDeleted: false,
});

/** Fixed-size measurement, so byte assertions are arithmetic rather than JSON. */
const fixedBytes = (bytes: number) => (): number => bytes;

describe("encodedElementByteLength", () => {
  it("measures the same JSON/UTF-8 form the protocol codec puts on the wire", () => {
    const target = element("abc");
    expect(encodedElementByteLength(target)).toBe(
      new TextEncoder().encode(JSON.stringify(target)).byteLength,
    );
  });

  it("charges an unencodable element the full budget instead of nothing", () => {
    // A value the codec would also refuse. Counting it as free would let it slip
    // into a delta that then cannot be encoded at send time.
    const circular = { id: "loop", version: 1, versionNonce: 1 } as Record<
      string,
      unknown
    >;
    circular.self = circular;
    expect(encodedElementByteLength(circular as unknown as SyncedElement)).toBe(
      DEFAULT_OFFLINE_QUEUE_MAX_BYTES,
    );
  });
});

describe("createOfflineChangeQueue", () => {
  it("reports nothing to send when no offline change happened", () => {
    const queue = createOfflineChangeQueue();
    expect(queue.drain(0)).toEqual({ mode: "none" });
  });

  it("coalesces repeated edits of one element into one entry", () => {
    const queue = createOfflineChangeQueue({ measureBytes: fixedBytes(10) });
    queue.record([element("a", 1)], 0);
    queue.record([element("a", 2)], 1);
    queue.record([element("a", 3)], 2);
    queue.record([element("b", 1)], 3);

    expect(queue.pendingElementCount()).toBe(2);
    expect(queue.pendingByteLength()).toBe(20);
    expect(queue.drain(4)).toEqual({ mode: "delta", elementCount: 2 });
  });

  it("measures nothing when an element is re-recorded at the same version", () => {
    // The affordability claim: a blocked flush re-extracts the same pending
    // elements every frame, so re-recording has to be free.
    const measure = vi.fn(fixedBytes(10));
    const queue = createOfflineChangeQueue({ measureBytes: measure });
    for (let frame = 0; frame < 50; frame += 1) {
      queue.record([element("a", 4, 9)], frame);
    }
    expect(measure).toHaveBeenCalledTimes(1);
    expect(queue.pendingByteLength()).toBe(10);
  });

  it("re-measures an equal version carrying a different nonce", () => {
    // Same version with a different nonce is a different edit under upstream's
    // conflict rules, so it is not the entry already held.
    const measure = vi.fn(fixedBytes(10));
    const queue = createOfflineChangeQueue({ measureBytes: measure });
    queue.record([element("a", 4, 1)], 0);
    queue.record([element("a", 4, 2)], 1);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(queue.pendingElementCount()).toBe(1);
    expect(queue.pendingByteLength()).toBe(10);
  });

  it("ignores an older version arriving after a newer one", () => {
    const queue = createOfflineChangeQueue({ measureBytes: fixedBytes(10) });
    queue.record([element("a", 5)], 0);
    queue.record([element("a", 2)], 1);
    expect(queue.pendingByteLength()).toBe(10);
    expect(queue.drain(2)).toEqual({ mode: "delta", elementCount: 1 });
  });

  it("degrades to one full sync past the element limit", () => {
    const queue = createOfflineChangeQueue({
      maxElements: 3,
      measureBytes: fixedBytes(1),
    });
    queue.record([element("a"), element("b"), element("c"), element("d")], 0);
    expect(queue.fullSyncReason()).toBe("element-limit");
    // The accounting is dropped with it: the bound exists to cap memory, so
    // keeping the map would defeat it.
    expect(queue.pendingElementCount()).toBe(0);
    expect(queue.pendingByteLength()).toBe(0);
    expect(queue.drain(1)).toEqual({
      mode: "full-sync",
      reason: "element-limit",
    });
  });

  it("degrades to one full sync past the byte limit", () => {
    const queue = createOfflineChangeQueue({
      maxBytes: 25,
      measureBytes: fixedBytes(10),
    });
    queue.record([element("a"), element("b")], 0);
    expect(queue.fullSyncReason()).toBeUndefined();
    queue.record([element("c")], 1);
    expect(queue.drain(2)).toEqual({ mode: "full-sync", reason: "byte-limit" });
  });

  it("charges the growth when an element is re-measured larger", () => {
    const sizes = new Map([
      ["a", 10],
      ["a-grown", 30],
    ]);
    const queue = createOfflineChangeQueue({
      maxBytes: 25,
      measureBytes: (target) =>
        sizes.get(target.version === 1 ? "a" : "a-grown") ?? 0,
    });
    queue.record([element("a", 1)], 0);
    expect(queue.pendingByteLength()).toBe(10);
    queue.record([element("a", 2)], 1);
    expect(queue.drain(2)).toEqual({ mode: "full-sync", reason: "byte-limit" });
  });

  it("degrades to one full sync once the offline window is too old", () => {
    const queue = createOfflineChangeQueue({
      maxAgeMs: 1_000,
      measureBytes: fixedBytes(1),
    });
    queue.record([element("a")], 0);
    queue.record([element("b")], 900);
    expect(queue.fullSyncReason()).toBeUndefined();
    queue.record([element("c")], 1_500);
    expect(queue.drain(1_600)).toEqual({
      mode: "full-sync",
      reason: "age-limit",
    });
  });

  it("ages out at drain time even when nothing else was recorded", () => {
    // A session can sit disconnected without drawing at all, and the room's
    // membership still turns over while it waits.
    const queue = createOfflineChangeQueue({
      maxAgeMs: 1_000,
      measureBytes: fixedBytes(1),
    });
    queue.record([element("a")], 0);
    expect(queue.drain(5_000)).toEqual({
      mode: "full-sync",
      reason: "age-limit",
    });
  });

  it("stops measuring once a bound has been tripped", () => {
    const measure = vi.fn(fixedBytes(1));
    const queue = createOfflineChangeQueue({
      maxElements: 1,
      measureBytes: measure,
    });
    queue.record([element("a"), element("b")], 0);
    measure.mockClear();
    queue.record([element("c"), element("d")], 1);
    expect(measure).not.toHaveBeenCalled();
    expect(queue.fullSyncReason()).toBe("element-limit");
  });

  it("resets after a drain, so the next offline window starts clean", () => {
    const queue = createOfflineChangeQueue({
      maxAgeMs: 1_000,
      measureBytes: fixedBytes(1),
    });
    queue.record([element("a")], 0);
    expect(queue.drain(5_000).mode).toBe("full-sync");
    expect(queue.drain(6_000)).toEqual({ mode: "none" });

    queue.record([element("b")], 6_000);
    expect(queue.drain(6_500)).toEqual({ mode: "delta", elementCount: 1 });
  });

  it("clears a tripped bound as well as the entries", () => {
    const queue = createOfflineChangeQueue({
      maxElements: 1,
      measureBytes: fixedBytes(1),
    });
    queue.record([element("a"), element("b")], 0);
    queue.clear();
    expect(queue.fullSyncReason()).toBeUndefined();
    expect(queue.drain(1)).toEqual({ mode: "none" });
  });

  it("rejects bounds that are not positive integers", () => {
    expect(() => createOfflineChangeQueue({ maxElements: 0 })).toThrow(
      /maxElements/,
    );
    expect(() => createOfflineChangeQueue({ maxBytes: -1 })).toThrow(
      /maxBytes/,
    );
    expect(() => createOfflineChangeQueue({ maxAgeMs: 1.5 })).toThrow(
      /maxAgeMs/,
    );
  });
});
