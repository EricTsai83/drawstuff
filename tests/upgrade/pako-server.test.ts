// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { compressData, decompressData } from "@/lib/encode";

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/legacy-scenes",
);

describe("Pako server compatibility", () => {
  it("opens a persisted scene envelope written by Pako 2", async () => {
    const source = (
      await readFile(
        path.join(fixtureDirectory, "shapes-and-text.pako-2-compressed.base64"),
        "utf8",
      )
    ).trim();
    const compressed = Uint8Array.from(Buffer.from(source, "base64"));

    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
    });
    const scene = JSON.parse(new TextDecoder().decode(data)) as {
      type: string;
      elements: Array<{ type: string }>;
    };

    expect(scene.type).toBe("excalidraw");
    expect(scene.elements.map((element) => element.type)).toEqual([
      "rectangle",
      "text",
    ]);
  });

  it("opens a persisted scene produced by a compatible zlib encoder", async () => {
    const source = (
      await readFile(
        path.join(fixtureDirectory, "shapes-and-text.compressed.base64"),
        "utf8",
      )
    ).trim();
    const compressed = Uint8Array.from(Buffer.from(source, "base64"));

    const { data } = await decompressData<Record<string, never>>(compressed, {
      decryptionKey: "",
    });
    const scene = JSON.parse(new TextDecoder().decode(data)) as {
      type: string;
      elements: Array<{ type: string }>;
    };

    expect(scene.type).toBe("excalidraw");
    expect(scene.elements.map((element) => element.type)).toEqual([
      "rectangle",
      "text",
    ]);
  });

  it("reopens production-like scene data written by Pako 3", async () => {
    const source = await readFile(
      path.join(fixtureDirectory, "large-groups-and-viewport.excalidraw"),
    );
    const compressed = await compressData(source, {
      metadata: { kind: "scene", schemaVersion: 2 },
    });

    const restored = await decompressData<{
      kind: string;
      schemaVersion: number;
    }>(compressed, { decryptionKey: "" });

    expect(restored.metadata).toEqual({ kind: "scene", schemaVersion: 2 });
    expect(Buffer.from(restored.data)).toEqual(source);
  });
});
