import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDrawstuffDocumentV4,
  DRAWSTUFF_DOCUMENT_VERSION,
  parseDrawstuffDocument,
  serializeDrawstuffDocumentV4,
  toNativeExcalidrawScene,
} from "../src/codec";

const elements = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "fixtures/native-excalidraw-elements.json",
    ),
    "utf8",
  ),
) as readonly Record<string, unknown>[];

describe("DrawstuffDocumentV4", () => {
  it("keeps the approved V4 byte and semantic digest", () => {
    const serialized = serializeDrawstuffDocumentV4(
      createDrawstuffDocumentV4({
        elements,
        appState: {
          name: "Digest fixture",
          viewBackgroundColor: "#ffffff",
          gridSize: 20,
        },
      }),
    );

    expect(Buffer.byteLength(serialized)).toBe(5_638);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "a19961cd33772399749a638ad90b0c8aae44ec8bd72fae8fdc232fd4c8fecbb9",
    );
  });

  it("preserves complete ordered native elements and unknown fields", () => {
    const serialized = serializeDrawstuffDocumentV4(
      createDrawstuffDocumentV4({
        elements,
        appState: {
          name: "Native fixture",
          theme: "dark",
          viewBackgroundColor: "#ffffff",
          gridSize: 20,
          scrollX: 500,
          scrollY: -200,
          zoom: { value: 1.5 },
          activeTool: { type: "rectangle" },
        },
      }),
    );
    const loaded = parseDrawstuffDocument(serialized);
    const native = toNativeExcalidrawScene(loaded);

    expect(loaded.version).toBe(DRAWSTUFF_DOCUMENT_VERSION);
    expect(loaded.engine).toEqual({
      name: "excalidraw",
    });
    expect(native.elements).toEqual(elements);
    expect(native.elements.map((element) => element.id)).toEqual(
      elements.map((element) => element.id),
    );
    expect(
      native.elements.find((element) => element.id === "rect-1"),
    ).toMatchObject({
      index: "a1",
      version: 7,
      versionNonce: 1002,
      boundElements: [
        { id: "text-1", type: "text" },
        { id: "arrow-1", type: "arrow" },
      ],
      futureNativeField: { mustSurvive: "round-trip" },
    });
    expect(
      native.elements.find((element) => element.id === "deleted-1"),
    ).toMatchObject({ isDeleted: true, version: 5, versionNonce: 1010 });
    expect(loaded.scene.appState).toEqual({
      viewBackgroundColor: "#ffffff",
      gridSize: 20,
    });
    expect(loaded.scene.appState).not.toHaveProperty("theme");
    expect(loaded.scene.appState).not.toHaveProperty("scrollX");
    expect(loaded.scene.appState).not.toHaveProperty("zoom");
  });

  it("reads V4 documents written by older Excalidraw versions", () => {
    const historical = {
      ...createDrawstuffDocumentV4({
        elements,
        appState: { name: "Historical fixture" },
      }),
      engine: {
        name: "excalidraw" as const,
        version: "0.18.1",
      },
    };

    expect(parseDrawstuffDocument(historical)).toEqual(historical);
  });

  it("reads raw legacy Excalidraw and deterministic Whiteboard V3", () => {
    const legacy = parseDrawstuffDocument({
      elements,
      appState: { name: "Legacy", theme: "light", scrollX: 99 },
    });
    expect(legacy.metadata.name).toBe("Legacy");
    expect(legacy.scene.elements).toEqual(elements);
    expect(legacy.scene.appState).not.toHaveProperty("scrollX");

    const v3 = parseDrawstuffDocument({
      version: 3,
      elements: [
        {
          id: "v3-rect",
          type: "rectangle",
          updatedAt: 1234,
          roundness: "round",
          customData: { retained: true },
        },
      ],
      metadata: { name: "V3 fixture", theme: "dark" },
    });
    const converted = v3.scene.elements[0] as Record<string, unknown>;
    expect(converted.updated).toBe(1234);
    expect(converted).not.toHaveProperty("updatedAt");
    expect(converted.roundness).toEqual({ type: 3 });
    expect(converted.customData).toMatchObject({
      retained: true,
      drawstuffWhiteboardV3: {
        id: "v3-rect",
        updatedAt: 1234,
      },
    });
  });
});
