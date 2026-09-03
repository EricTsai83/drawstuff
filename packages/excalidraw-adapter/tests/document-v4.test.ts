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
    const loaded = parsedDocument(serialized);
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

  it("drops the removed engine.version and theme fields of historical V4 rows", () => {
    const historical = {
      ...createDrawstuffDocumentV4({
        elements,
        appState: { name: "Historical fixture", viewBackgroundColor: "#fff" },
      }),
      engine: {
        name: "excalidraw" as const,
        version: "0.18.1",
      },
      scene: {
        elements,
        appState: { viewBackgroundColor: "#fff", theme: "dark" },
      },
    };
    const parsed = parsedDocument(historical);

    expect(parsed.engine).toEqual({ name: "excalidraw" });
    expect(parsed.scene.appState).toEqual({ viewBackgroundColor: "#fff" });
    expect(parsed.scene.elements).toEqual(elements);
    expect(parsed.metadata.name).toBe("Historical fixture");
    expect(serializeDrawstuffDocumentV4(historical)).not.toContain('"theme"');
  });

  it("drops non-contract fields from asset entries instead of carrying them", () => {
    const stored = {
      ...createDrawstuffDocumentV4({ elements, appState: { name: "Assets" } }),
      assets: {
        "asset-1": {
          id: "asset-1",
          storage: "external" as const,
          mimeType: "image/png",
          uploadedBy: "someone@example.com",
        },
      },
    };
    const parsed = parsedDocument(stored);

    expect(parsed.assets).toEqual({
      "asset-1": {
        id: "asset-1",
        storage: "external",
        mimeType: "image/png",
      },
    });
    expect(serializeDrawstuffDocumentV4(stored)).not.toContain("uploadedBy");
  });

  it.each([
    [
      "a raw Excalidraw payload",
      { elements, appState: { name: "Legacy", theme: "light" } },
    ],
    [
      "an Owned Whiteboard V3 payload",
      {
        version: 3,
        elements: [{ id: "v3-rect", type: "rectangle", updatedAt: 1234 }],
        metadata: { name: "V3 fixture", theme: "dark" },
      },
    ],
    [
      "an upstream format-version-3 export",
      {
        type: "excalidraw",
        version: 3,
        source: "https://excalidraw.com",
        elements,
        appState: { name: "Upstream v3" },
      },
    ],
  ])("refuses %s instead of upgrading it on read", (_label, payload) => {
    // Stored rows were rewritten to V4 once (2026-08-01) and audited empty of
    // anything else; a reader that quietly upgraded would be a lingering shim.
    expect(parseDrawstuffDocument(payload)).toEqual({
      ok: false,
      error: {
        code: "unsupported-payload",
        detail: "Unsupported Drawstuff document payload",
      },
    });
  });

  it("rejects payloads that are neither V4 documents nor Excalidraw scenes", () => {
    expect(parseDrawstuffDocument({ version: 4 })).toEqual({
      ok: false,
      error: {
        code: "unsupported-payload",
        detail: "Unsupported Drawstuff document payload",
      },
    });
  });

  it("rejects strings that are not JSON without throwing", () => {
    expect(parseDrawstuffDocument("{not json")).toMatchObject({
      ok: false,
      error: { code: "malformed-json" },
    });
  });
});

function parsedDocument(payload: unknown) {
  const result = parseDrawstuffDocument(payload);
  if (!result.ok) {
    throw new Error(`expected ok parse, got ${result.error.code}`);
  }
  return result.document;
}
