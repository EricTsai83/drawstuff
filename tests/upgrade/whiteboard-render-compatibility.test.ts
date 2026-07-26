import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restore } from "@excalidraw/excalidraw";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { WhiteboardElement } from "@/features/whiteboard";
import { migrateLegacyExcalidrawScene } from "@/features/whiteboard";
import { getDocumentBounds } from "@/features/whiteboard/owned";

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/legacy-scenes",
);

describe("fixed scene render compatibility", () => {
  it.each([
    "shapes-and-text.excalidraw",
    "images-and-binary-files.excalidraw",
    "large-groups-and-viewport.excalidraw",
    "pre-migration-bindings.excalidraw",
  ])("preserves visible geometry and assets for %s", async (fixtureName) => {
    const source = await readFile(
      path.join(fixtureDirectory, fixtureName),
      "utf8",
    );
    const fixture = JSON.parse(source) as ImportedDataState;
    const legacy = restore(fixture, null, null, {
      repairBindings: true,
      refreshDimensions: false,
    });
    const owned = migrateLegacyExcalidrawScene(source);
    const legacyVisible = legacy.elements.filter(
      (element) => !element.isDeleted,
    );
    const ownedVisible = owned.elements.filter((element) => !element.isDeleted);

    expect(ownedVisible.map(({ id, type }) => ({ id, type }))).toEqual(
      legacyVisible.map(({ id, type }) => ({ id, type })),
    );
    expect(getDocumentBounds(ownedVisible)).toEqual(
      getDocumentBounds(
        legacyVisible as unknown as readonly WhiteboardElement[],
      ),
    );
    expect(Object.keys(owned.assets).sort()).toEqual(
      Object.keys(legacy.files).sort(),
    );
  });
});
