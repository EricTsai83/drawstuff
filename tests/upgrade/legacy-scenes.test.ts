import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { restore } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { STORAGE_KEYS } from "@/config/app-constants";
import { importFromLocalStorage } from "@/data/local-storage";
import { decompressData } from "@/lib/encode";
import {
  hasCompleteSceneFileHydration,
  ensureInitialAppState,
} from "@/lib/excalidraw";
import { extractImageFiles, processFilesForUpload } from "@/lib/file-processor";
import { loadPublishedSceneData } from "@/lib/published-scene-data";

type SceneFixture = {
  type: "excalidraw";
  version: 2;
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/legacy-scenes",
);

async function readFixture(name: string): Promise<SceneFixture> {
  const source = await readFile(path.join(fixtureDirectory, name), "utf8");
  return JSON.parse(source) as SceneFixture;
}

describe("legacy Excalidraw scenes", () => {
  it.each([
    ["shapes-and-text.excalidraw", 2],
    ["images-and-binary-files.excalidraw", 1],
    ["large-groups-and-viewport.excalidraw", 5],
    ["pre-migration-bindings.excalidraw", 2],
  ])("restores %s without dropping content", async (name, elementCount) => {
    const fixture = await readFixture(name);
    const restored = restore(fixture, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });

    expect(restored.elements).toHaveLength(elementCount);
    expect(restored.elements.every((element) => !element.isDeleted)).toBe(true);
  });

  it("preserves arrows, groups, and saved viewport state", async () => {
    const fixture = await readFixture("large-groups-and-viewport.excalidraw");
    const restored = restore(fixture, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });
    const groupIds = new Set(
      restored.elements.flatMap((element) => element.groupIds),
    );

    expect(restored.elements.some((element) => element.type === "arrow")).toBe(
      true,
    );
    expect(groupIds).toContain("legacy-group-a");
    expect(ensureInitialAppState(restored.appState).scrollX).toBe(315.5);
    expect(ensureInitialAppState(restored.appState).zoom?.value).toBe(0.75);
  });

  it("migrates pre-index binding and roundness fields", async () => {
    const fixture = await readFixture("pre-migration-bindings.excalidraw");
    const restored = restore(fixture, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });
    const box = restored.elements.find(
      (element) => element.id === "legacy-old-box",
    );

    expect(box?.index).toEqual(expect.any(String));
    expect(box?.frameId).toBeNull();
    expect(typeof box?.roundness?.type).toBe("number");
    expect(box?.boundElements).toEqual([
      { id: "legacy-old-arrow", type: "arrow" },
    ]);
  });

  it("loads a stable compressed legacy payload", async () => {
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
    const parsed = JSON.parse(new TextDecoder().decode(data)) as SceneFixture;

    expect(parsed.type).toBe("excalidraw");
    expect(parsed.elements.map((element) => element.type)).toEqual([
      "rectangle",
      "text",
    ]);
  });
});

describe("local recovery and binary files", () => {
  it("recovers local elements, viewport, and files while removing deleted elements", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const deletedElement = {
      ...fixture.elements[0]!,
      id: "deleted-image",
      isDeleted: true,
    };

    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([...fixture.elements, deletedElement]),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify({ ...fixture.appState, scrollX: 42, scrollY: -8 }),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      JSON.stringify(fixture.files),
    );

    const recovered = importFromLocalStorage();

    expect(recovered.elements.map((element) => element.id)).toEqual([
      "legacy-image",
    ]);
    expect(recovered.appState).toMatchObject({ scrollX: 42, scrollY: -8 });
    expect(recovered.files["legacy-image-file"]?.mimeType).toBe("image/png");
  });

  it("compresses an uploaded image and restores its binary metadata and data URL", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const imageFiles = extractImageFiles(fixture.elements, fixture.files);
    const [processed] = await processFilesForUpload({
      files: imageFiles,
      maxBytes: 1024 * 1024,
      encryptionKey: null,
    });

    expect(processed?.id).toBe("legacy-image-file");
    const restored = await decompressData<{
      id: FileId;
      mimeType: string;
      created: number;
      lastRetrieved: number;
    }>(processed!.buffer, { decryptionKey: "" });
    const dataURL = new TextDecoder().decode(restored.data) as DataURL;

    expect(restored.metadata.id).toBe("legacy-image-file");
    expect(restored.metadata.mimeType).toBe("image/png");
    expect(dataURL).toBe(fixture.files["legacy-image-file"]?.dataURL);
    expect(hasCompleteSceneFileHydration(fixture.elements, fixture.files)).toBe(
      true,
    );
    expect(hasCompleteSceneFileHydration(fixture.elements, {})).toBe(false);
  });

  it("loads published scene data in read-only mode with restored binary files", async () => {
    const fixture = await readFixture("images-and-binary-files.excalidraw");
    const sceneBytes = new TextEncoder().encode(JSON.stringify(fixture));
    const { compressData } = await import("@/lib/encode");
    const compressedScene = await compressData(sceneBytes, {});
    const binary = fixture.files["legacy-image-file"]!;
    const compressedFile = await compressData(
      new TextEncoder().encode(binary.dataURL),
      {
        metadata: {
          id: binary.id,
          mimeType: binary.mimeType,
          created: binary.created,
          lastRetrieved: binary.lastRetrieved,
        },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from(compressedFile).buffer, { status: 200 }),
      ),
    );

    const loaded = await loadPublishedSceneData({
      sceneData: Buffer.from(compressedScene).toString("base64"),
      fileRecords: [{ url: "https://files.example/legacy-image" }],
    });

    expect(loaded.appState?.viewModeEnabled).toBe(true);
    expect(loaded.appState?.zenModeEnabled).toBe(true);
    expect(loaded.appState?.scrollX).toBeUndefined();
    expect(loaded.files?.["legacy-image-file"]?.dataURL).toBe(binary.dataURL);
  });
});
