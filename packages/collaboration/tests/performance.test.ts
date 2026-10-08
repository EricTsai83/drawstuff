import { describe, expect, it } from "vitest";
import {
  formatServerTimings,
  readServerTimings,
  performanceTimingsSchema,
} from "../src/performance";

describe("private numeric server timings", () => {
  it("round trips allowed metrics without serializing extra fields", () => {
    const timings = { gateway: 12.345, registerStorage: 0, secret: "private" };
    const header = formatServerTimings(timings);
    expect(header).not.toContain("secret");
    expect(header).not.toContain("private");
    expect(readServerTimings(header)).toEqual({
      gateway: 12.35,
      registerStorage: 0,
    });
  });
  it("ignores unknown, malformed, nonfinite, oversized and out-of-range headers", () => {
    expect(
      readServerTimings(
        "identity;dur=-1, secret;dur=2, gateway;dur=Infinity, room;dur=120001, callback;dur=5",
      ),
    ).toEqual({ callback: 5 });
    expect(readServerTimings("x".repeat(2049))).toEqual({});
    expect(formatServerTimings({ room: NaN, callback: Infinity })).toBe("");
    expect(
      performanceTimingsSchema.safeParse({ privateUrl: "secret" }).success,
    ).toBe(false);
  });
});
