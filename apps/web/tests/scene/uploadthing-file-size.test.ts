import { describe, expect, it } from "vitest";
import { getMaxFileSizeString } from "@/lib/utils";

const MiB = 2 ** 20;

describe("getMaxFileSizeString", () => {
  it("picks the smallest power-of-two limit that admits the cap", () => {
    expect(getMaxFileSizeString(MiB)).toBe("1MB");
    expect(getMaxFileSizeString(3 * MiB)).toBe("4MB");
    expect(getMaxFileSizeString(16 * MiB)).toBe("16MB");
  });

  it("never rounds below the cap", () => {
    // 4.4 MiB used to round to "4MB" and refuse files the app allows.
    expect(getMaxFileSizeString(4.4 * MiB)).toBe("8MB");
    expect(getMaxFileSizeString(512 * MiB + 1)).toBe("1GB");
  });
});
