import {
  createOwnedSceneDocumentV4,
  createReadonlyShareDocumentV4,
  serializeDrawstuffDocumentV4,
} from "@drawstuff/excalidraw-adapter/codec";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import { describe, expect, it, vi } from "vitest";

const { getSceneQuery, getSharedSceneQuery } = vi.hoisted(() => ({
  getSceneQuery: vi.fn(),
  getSharedSceneQuery: vi.fn(),
}));

vi.mock("@/trpc/client", () => ({
  getTrpcClient: () => ({
    scene: {
      getScene: { query: getSceneQuery },
    },
    sharedScene: {
      getCompressedBySharedSceneId: { query: getSharedSceneQuery },
    },
  }),
}));

import { compressData } from "@/lib/encode";
import {
  importDataFromBackend,
  importSceneDataBySceneId,
} from "@/lib/import-data-from-db";
import { decodePersistedScene } from "@/lib/persisted-scene";

/**
 * How the pre-V4 writer persisted elements: no `groupIds`, `seed`,
 * `versionNonce`, `boundElements`, `updated`, `link`, `roundness`, `index` or
 * `frameId`. 34 of 39 production rows still look like this.
 */
const legacyElement = {
  id: "legacy-rectangle",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  version: 7,
  isDeleted: false,
};

const strippedFields = [
  "groupIds",
  "seed",
  "versionNonce",
  "boundElements",
  "updated",
  "link",
  "roundness",
  "index",
  "frameId",
] as const;

describe("persisted scene restore boundary", () => {
  it("restores legacy elements read by scene id", async () => {
    getSceneQuery.mockResolvedValue({
      name: "Legacy scene",
      revision: 3,
      sceneData: await encodeOwnedScene(),
      updatedAt: "2026-08-01T00:00:00.000Z",
      workspaceId: "workspace-1",
    });

    const imported = await importSceneDataBySceneId("scene-1");

    expect(imported.elements).toHaveLength(1);
    expectRestoredDefaults(imported.elements?.[0]);
    // Payload fields the reader must neither invent nor drop. Upstream
    // restore bumps `version` when it normalizes a repaired element, so only
    // require it not to regress.
    expect(imported.elements?.[0]).toMatchObject({
      id: legacyElement.id,
      width: legacyElement.width,
    });
    expect(
      (imported.elements?.[0] as { version: number }).version,
    ).toBeGreaterThanOrEqual(legacyElement.version);
    expect(imported.revision).toBe(3);
  });

  it("restores legacy elements read from a shared link", async () => {
    getSharedSceneQuery.mockResolvedValue({
      compressedData: await compressData(
        new TextEncoder().encode(
          serializeDrawstuffDocumentV4(
            createReadonlyShareDocumentV4({
              appState: { name: "Legacy share" },
              elements: [legacyElement],
            }),
          ),
        ),
        { encryptionKey: null },
      ),
    });

    const imported = await importDataFromBackend("shared-1", "");

    expect(imported.elements).toHaveLength(1);
    expectRestoredDefaults(imported.elements?.[0]);
  });

  it("restores legacy elements on the published page read", async () => {
    const decoded = decodePersistedScene(
      new TextEncoder().encode(
        serializeDrawstuffDocumentV4(
          createOwnedSceneDocumentV4({
            appState: { name: "Legacy scene" },
            elements: [legacyElement],
          }),
        ),
      ),
    );

    expect(decoded.elements).toHaveLength(1);
    expectRestoredDefaults(decoded.elements[0]);
  });

  // Tripwire for the stored-data backfill invariant: upstream restore does
  // NOT default `pressures`/`simulatePressure`, and its SVG export silently
  // drops any freedraw stroke missing them. Stored rows were backfilled once;
  // the writer must never strip the pair again.
  it("carries freedraw pressure fields through the serialize→decode round-trip", () => {
    const freedrawElement = {
      ...legacyElement,
      id: "modern-freedraw",
      type: "freedraw",
      points: [
        [0, 0],
        [10, 10],
        [20, 5],
      ],
      pressures: [0.4, 0.6, 0.8],
      simulatePressure: false,
    };
    const decoded = decodePersistedScene(
      new TextEncoder().encode(
        serializeDrawstuffDocumentV4(
          createOwnedSceneDocumentV4({
            appState: { name: "Pen scene" },
            elements: [freedrawElement],
          }),
        ),
      ),
    );

    expect(decoded.elements).toHaveLength(1);
    const freedraw = decoded.elements[0] as unknown as {
      pressures: unknown;
      simulatePressure: unknown;
    };
    expect(freedraw.pressures).toEqual([0.4, 0.6, 0.8]);
    expect(freedraw.simulatePressure).toBe(false);
  });

  it("does not crash the unguarded field reads updateScene performs", async () => {
    getSceneQuery.mockResolvedValue({
      name: "Legacy scene",
      sceneData: await encodeOwnedScene(),
    });

    const imported = await importSceneDataBySceneId("scene-1");

    // Mirrors upstream's render/group/z-index code, which reads these without
    // a guard and previously threw "Cannot read properties of undefined
    // (reading 'length')" inside a forEach.
    const readLengths = () =>
      (imported.elements ?? []).map(
        (element) =>
          element.groupIds.length + (element.boundElements?.length ?? 0),
      );

    expect(readLengths).not.toThrow();
    expect(readLengths()).toEqual([0]);
  });

  it("keeps a missing viewport missing so auto-centering still triggers", async () => {
    getSceneQuery.mockResolvedValue({
      name: "Legacy scene",
      sceneData: await encodeOwnedScene(),
    });

    const imported = await importSceneDataBySceneId("scene-1");

    expect(imported.appState?.scrollX).toBeUndefined();
    expect(imported.appState?.scrollY).toBeUndefined();
    expect(imported.appState?.zoom).toBeUndefined();
    expect(imported.appState?.name).toBe("Legacy scene");
  });
});

async function encodeOwnedScene(): Promise<string> {
  const compressed = await compressData(
    new TextEncoder().encode(
      serializeDrawstuffDocumentV4(
        createOwnedSceneDocumentV4({
          appState: { name: "Legacy scene" },
          elements: [legacyElement],
        }),
      ),
    ),
    { encryptionKey: null },
  );

  return Buffer.from(compressed).toString("base64");
}

function expectRestoredDefaults(element: ExcalidrawElement | undefined): void {
  expect(element).toBeDefined();
  const restored = element as unknown as Record<string, unknown>;

  for (const field of strippedFields) {
    expect(legacyElement).not.toHaveProperty(field);
    expect(restored).toHaveProperty(field);
  }

  expect(restored.groupIds).toEqual([]);
  expect(restored.boundElements).toEqual([]);
  expect(restored.seed).toEqual(expect.any(Number));
  expect(restored.versionNonce).toEqual(expect.any(Number));
  expect(restored.updated).toEqual(expect.any(Number));
  expect(restored.link).toBeNull();
  expect(restored.roundness).toBeNull();
  expect(restored.frameId).toBeNull();
}
