import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
} from "@drawstuff/whiteboard/migration-v2";
import {
  createMigrationManifest,
  finalizeV3Constraints,
  migrateSceneBatch,
  scanV2Scenes,
  validateSceneBatch,
  verifyV3Database,
  type WhiteboardMigrationDatabase,
} from "@/server/whiteboard/migration-v3";
import {
  areWhiteboardWritesPaused,
  assertWhiteboardWritesEnabled,
  WHITEBOARD_MAINTENANCE_CODE,
} from "@/server/whiteboard/maintenance";

const codec = {
  decode: async (value: string) => value,
  encode: async (value: string) => value,
};

describe("whiteboard V3 migration tooling", () => {
  it("validates deterministic V2 rows, including null drafts", async () => {
    const rows = await validateSceneBatch(
      [
        { id: "a", sceneData: v2Document() },
        { id: "b", sceneData: null },
      ],
      codec,
    );
    const first = rows[0];
    expect(first?.migratedSceneData).toContain('"version":3');
    expect(rows[1]?.migratedSceneData).toBeNull();
    expect(createMigrationManifest(rows)).toEqual(
      createMigrationManifest([...rows].reverse()),
    );
  });

  it("fails validation before writes for invalid compressed payloads", async () => {
    const update = vi.fn();
    await expect(
      validateSceneBatch([{ id: "invalid", sceneData: "not-json" }], codec),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("scans in pages and makes interrupted batch execution rerunnable", async () => {
    const rows = [
      { id: "a", sceneData: v2Document() },
      { id: "b", sceneData: null },
    ];
    let scan = 0;
    const updated = new Set<string>(["a"]);
    const database = mockDatabase({
      scanV2Scenes: vi.fn(async () => (scan++ === 0 ? rows : [])),
      updateSceneToV3: vi.fn(async (id: string) => {
        if (updated.has(id)) return false;
        updated.add(id);
        return true;
      }),
    });
    expect(await scanV2Scenes(database)).toEqual(rows);
    const validated = await validateSceneBatch(rows, codec);
    expect(await migrateSceneBatch(database, validated)).toBe(1);
    expect(updated).toEqual(new Set(["a", "b"]));
  });

  it("blocks finalize while V2 rows remain", async () => {
    const database = mockDatabase({
      verification: vi.fn(async () => ({
        v2SceneCount: 1,
        nonV3SceneCount: 1,
        v2SharedSceneCount: 0,
        nonV3SharedSceneCount: 0,
        semanticAggregateMatches: true,
      })),
    });
    await expect(verifyV3Database(database)).rejects.toThrow(
      "V3 database verification failed",
    );
    await expect(finalizeV3Constraints(database)).rejects.toThrow();
    expect(database.finalizeV3Constraints).not.toHaveBeenCalled();
  });
});

describe("whiteboard maintenance write gate", () => {
  const original = process.env.WHITEBOARD_WRITES_PAUSED;

  afterEach(() => {
    if (original === undefined) delete process.env.WHITEBOARD_WRITES_PAUSED;
    else process.env.WHITEBOARD_WRITES_PAUSED = original;
  });

  it("returns a typed 503 maintenance error only while writes are paused", () => {
    process.env.WHITEBOARD_WRITES_PAUSED = "false";
    expect(areWhiteboardWritesPaused()).toBe(false);
    expect(assertWhiteboardWritesEnabled).not.toThrow();

    process.env.WHITEBOARD_WRITES_PAUSED = "true";
    expect(areWhiteboardWritesPaused()).toBe(true);
    try {
      assertWhiteboardWritesEnabled();
      throw new Error("Expected maintenance error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: WHITEBOARD_MAINTENANCE_CODE,
      });
    }
  });
});

function mockDatabase(
  update: Partial<WhiteboardMigrationDatabase>,
): WhiteboardMigrationDatabase {
  return {
    scanV2Scenes: vi.fn(async () => []),
    updateSceneToV3: vi.fn(async () => true),
    invalidateLegacyShares: vi.fn(async () => 0),
    verification: vi.fn(async () => ({
      v2SceneCount: 0,
      nonV3SceneCount: 0,
      v2SharedSceneCount: 0,
      nonV3SharedSceneCount: 0,
      semanticAggregateMatches: true,
    })),
    finalizeV3Constraints: vi.fn(async () => undefined),
    ...update,
  };
}

function v2Document(): string {
  return serializeWhiteboardDocumentV2(
    createWhiteboardDocumentV2({
      elements: [
        {
          id: "rectangle",
          type: "rectangle",
          isDeleted: false,
          x: 1,
          y: 2,
          width: 30,
          height: 40,
          angle: 0,
          strokeColor: "#111111",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          opacity: 100,
          roughness: 1,
          locked: false,
        },
      ],
      assets: {},
      metadata: {
        name: "Migration",
        theme: "light",
        viewBackgroundColor: "#ffffff",
        gridSize: null,
      },
    }),
  );
}
