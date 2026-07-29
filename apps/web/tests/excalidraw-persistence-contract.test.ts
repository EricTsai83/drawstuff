import { readFileSync } from "node:fs";
import path from "node:path";
import { restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vitest";

import {
  createLocalExportDocument,
  createOwnedSceneDocumentV4,
  createReadonlyShareDocumentV4,
} from "@/lib/excalidraw-document-v4";
import {
  OFFICIAL_SERVER_APP_STATE_KEYS,
  selectOfficialServerAppState,
} from "@/lib/excalidraw-persistence-contract";
import { serializeSceneData } from "@/lib/export-scene-to-backend";

type JsonObject = Record<string, unknown>;

const fixtureDirectory = path.resolve(
  import.meta.dirname,
  "fixtures/excalidraw-0.18.1",
);

const contractInput = readFixture<{
  source: string;
  appState: JsonObject;
  elements: JsonObject[];
  files: JsonObject;
}>("contract-input.json");
const expectedLocal = readFixture<JsonObject>("official-local.json");
const expectedDatabase = readFixture<JsonObject>("official-database.json");
const restoreSummary = readFixture<{
  expectedElementIds: string[];
  expectedDeletedElementIds: string[];
}>("restore-summary.json");
const nativeElements = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "fixtures/native-excalidraw-elements.json",
    ),
    "utf8",
  ),
) as JsonObject[];

const elements = contractInput.elements as unknown as ExcalidrawElement[];
const appState = contractInput.appState as Partial<AppState>;
const files = contractInput.files as BinaryFiles;

describe("Excalidraw persistence contract", () => {
  it("defines the server appState allowlist", () => {
    expect(OFFICIAL_SERVER_APP_STATE_KEYS).toEqual([
      "gridSize",
      "gridStep",
      "gridModeEnabled",
      "viewBackgroundColor",
    ]);
  });

  it("matches official local and database serializers", () => {
    const officialLocal = JSON.parse(
      serializeAsJSON(elements, appState, files, "local"),
    ) as JsonObject;
    const officialDatabase = JSON.parse(
      serializeAsJSON(elements, appState, files, "database"),
    ) as JsonObject;

    expect(officialLocal).toEqual(expectedLocal);
    expect(officialDatabase).toEqual(expectedDatabase);
    expect(
      createLocalExportDocument({
        elements,
        appState,
        files,
        source: contractInput.source,
      }),
    ).toEqual(expectedLocal);
  });

  it("keeps native scene semantics across official restore", () => {
    const restored = restore(
      {
        elements: nativeElements as unknown as ExcalidrawElement[],
        appState,
        files,
      },
      null,
      null,
      { refreshDimensions: false, repairBindings: true },
    );

    expect(restored.elements.map(({ id }) => id)).toEqual(
      restoreSummary.expectedElementIds,
    );
    expect(
      restored.elements
        .filter(({ isDeleted }) => isDeleted)
        .map(({ id }) => id),
    ).toEqual(restoreSummary.expectedDeletedElementIds);
    expect(restored.elements.find(({ id }) => id === "rect-1")).toMatchObject({
      index: "a1",
      version: 7,
      versionNonce: 1002,
      customData: {
        domain: "fixture",
        nested: { retained: true },
      },
    });

    const databasePayload = JSON.parse(
      serializeAsJSON(
        restored.elements,
        restored.appState,
        restored.files,
        "database",
      ),
    ) as {
      elements: ExcalidrawElement[];
      appState: Partial<AppState>;
    };
    const restoredDatabasePayload = restore(databasePayload, null, null, {
      refreshDimensions: false,
      repairBindings: true,
    });
    expect(
      restoredDatabasePayload.elements.some(({ isDeleted }) => isDeleted),
    ).toBe(false);
  });

  it("uses one server appState adapter for owned and readonly cloud data", () => {
    const expectedAppState = {
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: true,
      viewBackgroundColor: "#f8f9fa",
    };

    expect(selectOfficialServerAppState(appState)).toEqual(expectedAppState);

    const owned = createOwnedSceneDocumentV4({
      elements,
      appState,
      files,
      name: "Owned",
    });
    const readonly = createReadonlyShareDocumentV4({
      elements,
      appState,
      files,
      name: "Readonly",
    });

    expect(owned.scene.appState).toEqual(expectedAppState);
    expect(owned.scene.elements).toHaveLength(4);
    expect(owned.assets).toHaveProperty("file-live");
    expect(readonly.scene.appState).toEqual(expectedAppState);
    expect(readonly.scene.elements.map(elementId)).toEqual([
      "rectangle-live",
      "line-live",
      "image-live",
    ]);
    expect(readonly.assets).toEqual({});
    expect(JSON.stringify(readonly)).not.toContain("file-deleted");
    expect(JSON.stringify(readonly)).not.toContain('"theme"');

    const readonlyWriterOutput = JSON.parse(
      serializeSceneData(elements, appState, files, "readonly-share"),
    ) as {
      scene: { elements: unknown[]; appState: JsonObject };
      assets: JsonObject;
    };
    expect(readonlyWriterOutput.scene.elements.map(elementId)).toEqual([
      "rectangle-live",
      "line-live",
      "image-live",
    ]);
    expect(readonlyWriterOutput.scene.appState).toEqual(expectedAppState);
    expect(readonlyWriterOutput.assets).toEqual({});
  });
});

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(fixtureDirectory, name), "utf8"),
  ) as T;
}

function elementId(element: unknown): unknown {
  return typeof element === "object" && element !== null && "id" in element
    ? element.id
    : undefined;
}
