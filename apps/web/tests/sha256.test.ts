import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const abc = new TextEncoder().encode("abc");

describe("sha256Hex", () => {
  it("hashes an ArrayBuffer, a Uint8Array and a Blob identically", async () => {
    expect(await sha256Hex(abc.slice().buffer)).toBe(ABC);
    expect(await sha256Hex(abc)).toBe(ABC);
    expect(await sha256Hex(new Blob([abc]))).toBe(ABC);
  });

  it("hashes only the viewed window of an offset view", async () => {
    const padded = new Uint8Array([0, ...abc, 0]);
    expect(await sha256Hex(padded.subarray(1, 4))).toBe(ABC);
  });

  it("accepts a view over shared memory", async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set(abc);
    expect(await sha256Hex(shared)).toBe(ABC);
  });
});
