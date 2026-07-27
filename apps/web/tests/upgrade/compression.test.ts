// @vitest-environment node

import { describe, expect, it } from "vitest";

import { compressData, decompressData } from "@/lib/encode";

describe("scene compression", () => {
  it("round-trips current metadata and bytes", async () => {
    const source = new TextEncoder().encode(
      JSON.stringify({ version: 2, name: "Current" }),
    );
    const compressed = await compressData(source, {
      metadata: { kind: "scene", schemaVersion: 2 },
    });

    const restored = await decompressData<{
      kind: string;
      schemaVersion: number;
    }>(compressed, { decryptionKey: "" });

    expect(restored.metadata).toEqual({ kind: "scene", schemaVersion: 2 });
    expect(restored.data).toEqual(source);
  });

  it("rejects decompressed output beyond the caller's limit", async () => {
    const compressed = await compressData(
      new TextEncoder().encode("x".repeat(10_000)),
      {},
    );

    await expect(
      decompressData<Record<string, never>>(compressed, {
        decryptionKey: "",
        maxDecompressedBytes: 1_000,
      }),
    ).rejects.toThrow("configured limit");
  });
});
