import {
  createDrawstuffDocumentV4,
  parseDrawstuffDocument,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import { readAdapterFixture } from "@drawstuff/excalidraw-adapter/testing";
import type {
  BinaryFiles,
  ExcalidrawElement,
} from "@drawstuff/excalidraw-adapter/types";
import { describe, expect, it } from "vitest";

import {
  base64ToArrayBuffer,
  compressData,
  decompressData,
} from "@/lib/encode";
import { serializeSceneData } from "@/lib/export-scene-to-backend";

const elements = readFixture<readonly Record<string, unknown>[]>(
  "native-excalidraw-elements.json",
);
const contractInput = readFixture<{
  appState: Record<string, unknown>;
  elements: Record<string, unknown>[];
  files: Record<string, unknown>;
}>("excalidraw-0.18.1/contract-input.json");

describe("Drawstuff cloud codec", () => {
  it("keeps deleted tombstones through compression", async () => {
    const serialized = serializeDrawstuffDocumentV4(
      createDrawstuffDocumentV4({
        elements,
        appState: { name: "Compressed fixture" },
      }),
    );
    const compressed = await compressData(
      new TextEncoder().encode(serialized),
      {},
    );
    const encoded = Buffer.from(compressed).toString("base64");
    const exactBuffer = base64ToArrayBuffer(encoded);
    const { data } = await decompressData<Record<string, never>>(
      new Uint8Array(exactBuffer),
      { decryptionKey: "" },
    );
    const result = parseDrawstuffDocument(new TextDecoder().decode(data));
    if (!result.ok) throw new Error(result.error.detail);
    const loaded = result.document;

    expect(new Uint8Array(exactBuffer).byteLength).toBe(compressed.byteLength);
    expect(loaded.scene.elements).toHaveLength(elements.length);
    expect(
      loaded.scene.elements.some(
        (element) =>
          (element as Record<string, unknown>).id === "deleted-1" &&
          (element as Record<string, unknown>).isDeleted === true,
      ),
    ).toBe(true);
  });

  it("routes readonly shares through the sanitizing persistence profile", () => {
    const output = JSON.parse(
      serializeSceneData(
        contractInput.elements as unknown as ExcalidrawElement[],
        contractInput.appState,
        contractInput.files as BinaryFiles,
        "readonly-share",
      ),
    ) as {
      scene: {
        appState: Record<string, unknown>;
        elements: Array<{ id?: unknown }>;
      };
      assets: Record<string, unknown>;
    };

    expect(output.scene.elements.map(({ id }) => id)).toEqual([
      "rectangle-live",
      "line-live",
      "image-live",
    ]);
    expect(output.scene.appState).toEqual({
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: true,
      viewBackgroundColor: "#f8f9fa",
    });
    expect(output.assets).toEqual({});
    expect(JSON.stringify(output)).not.toContain("file-deleted");
  });
});

function readFixture<T>(relativePath: string): T {
  return readAdapterFixture<T>(...relativePath.split("/"));
}
