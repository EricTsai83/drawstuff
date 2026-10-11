import { describe, expect, it } from "vitest";

import {
  createBoundedIdMap,
  createBoundedIdSet,
  createTransferGate,
  readBoundedBody,
} from "@/lib/collab/bounded-containers";

describe("createBoundedIdMap", () => {
  it("evicts the oldest entry once the limit is reached, reporting it", () => {
    const evicted: string[] = [];
    const map = createBoundedIdMap<number>(2, (id) => evicted.push(id));
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
    expect(evicted).toEqual(["a"]);
  });

  it("overwrites an existing id without evicting anything", () => {
    const evicted: string[] = [];
    const map = createBoundedIdMap<number>(2, (id) => evicted.push(id));
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 9);
    expect(map.get("a")).toBe(9);
    expect(map.get("b")).toBe(2);
    expect(evicted).toEqual([]);
  });
});

describe("createBoundedIdSet", () => {
  it("caps membership FIFO", () => {
    const set = createBoundedIdSet(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("createTransferGate", () => {
  it("never runs more than the limit concurrently and starves nobody", async () => {
    const gate = createTransferGate(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (index: number) =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        order.push(index);
      });
    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(peak).toBe(2);
    expect(order.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("releases the slot when a task throws", async () => {
    const gate = createTransferGate(1);
    await expect(
      gate.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    // The failed task must not pin the only slot.
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("readBoundedBody", () => {
  it("returns the body when it matches the bound", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const body = await readBoundedBody(new Response(bytes), 4);
    expect(body && [...body]).toEqual([1, 2, 3, 4]);
  });

  it("refuses a body that exceeds the bound", async () => {
    const bytes = new Uint8Array(64);
    expect(await readBoundedBody(new Response(bytes), 63)).toBeNull();
  });

  it("enforces the bound when the response has no streaming body", async () => {
    const fake = {
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
    } as unknown as Response;
    expect(await readBoundedBody(fake, 7)).toBeNull();
    expect(await readBoundedBody(fake, 8)).not.toBeNull();
  });
});
