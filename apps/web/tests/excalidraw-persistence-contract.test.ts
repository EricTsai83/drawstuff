import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isInvisiblySmallElement,
  reconcileElements,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vitest";

import {
  createCollaborationSnapshot,
  createLocalExportDocument,
  createOwnedSceneDocumentV4,
  createReadonlyShareDocumentV4,
} from "@/lib/excalidraw-document-v4";
import {
  EXCALIDRAW_PERSISTENCE_CONTRACT,
  EXCALIDRAW_STORAGE_PROFILE_MATRIX,
  getOfficialSyncableElements,
  inspectAssetReferences,
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
const syncableFixture = readFixture<{
  now: number;
  elements: JsonObject[];
  expectedSyncableElementIds: string[];
}>("syncable-elements.json");
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

describe("Excalidraw 0.18.1 persistence contract", () => {
  it("pins the upstream package, commit, appState allowlist, and profiles", () => {
    const packageJson = JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../node_modules/@excalidraw/excalidraw/package.json",
        ),
        "utf8",
      ),
    ) as { version: string };

    expect(packageJson.version).toBe(
      EXCALIDRAW_PERSISTENCE_CONTRACT.packageVersion,
    );
    expect(EXCALIDRAW_PERSISTENCE_CONTRACT.upstreamCommit).toBe(
      "a2ec2889babf7d2295469c6d90ebe77fae57df84",
    );
    expect(OFFICIAL_SERVER_APP_STATE_KEYS).toEqual([
      "gridSize",
      "gridStep",
      "gridModeEnabled",
      "viewBackgroundColor",
    ]);
    expect(Object.keys(EXCALIDRAW_STORAGE_PROFILE_MATRIX)).toEqual([
      "owned-scene",
      "readonly-share",
      "local-export",
      "collaboration-snapshot",
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

  it("matches the pinned collaboration tombstone and visibility policy", () => {
    const syncable = getOfficialSyncableElements(
      syncableFixture.elements,
      syncableFixture.now,
    );
    const snapshot = createCollaborationSnapshot(
      syncableFixture.elements,
      syncableFixture.now,
    );

    expect(syncable.map(elementId)).toEqual(
      syncableFixture.expectedSyncableElementIds,
    );
    expect(snapshot.elements.map(elementId)).toEqual(
      syncableFixture.expectedSyncableElementIds,
    );

    const liveElements = syncableFixture.elements.filter(
      (element) => !element.isDeleted,
    ) as unknown as ExcalidrawElement[];
    expect(
      liveElements
        .filter((element) => !isInvisiblySmallElement(element))
        .map(({ id }) => id),
    ).toEqual(["live-shape", "live-line"]);
  });

  it("reports missing, duplicate, and orphan fileId mappings", () => {
    expect(
      inspectAssetReferences(elements, [
        { excalidrawFileId: "file-live" },
        { excalidrawFileId: "file-live" },
        { excalidrawFileId: "file-orphan" },
      ]),
    ).toEqual({
      referencedFileIds: ["file-live"],
      missingFileIds: [],
      duplicateFileIds: ["file-live"],
      unreferencedFileIds: ["file-orphan"],
    });

    expect(inspectAssetReferences(elements, [])).toMatchObject({
      missingFileIds: ["file-live"],
    });
  });

  it("keeps upstream reconcileElements as the future merge baseline", () => {
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
    const localRectangle = restored.elements.find(({ id }) => id === "rect-1")!;
    const remoteRectangle = {
      ...localRectangle,
      x: 999,
      version: localRectangle.version + 1,
      versionNonce: localRectangle.versionNonce + 1,
      updated: localRectangle.updated + 1,
    };

    const reconciled = reconcileElements(
      restored.elements,
      [remoteRectangle as RemoteExcalidrawElement],
      restored.appState as AppState,
    );

    expect(reconciled.find(({ id }) => id === "rect-1")).toMatchObject({
      x: 999,
      version: remoteRectangle.version,
      versionNonce: remoteRectangle.versionNonce,
    });
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
