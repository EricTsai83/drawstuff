// @vitest-environment node

import { createHash } from "node:crypto";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  findScenes: vi.fn(),
  updateScene: vi.fn(),
  setScene: vi.fn(),
  whereScene: vi.fn(),
  returnScene: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: {
    query: {
      scene: {
        findMany: databaseMocks.findScenes,
      },
    },
    update: databaseMocks.updateScene,
  },
}));

import { parseWhiteboardDocumentV2 } from "@/features/whiteboard";
import { compressData, decompressData } from "@/lib/encode";
import { prepareWhiteboardSceneConvergence } from "@/server/whiteboard/data-convergence";
import { runWhiteboardConvergenceBatch } from "@/server/whiteboard/data-convergence";

async function encodeScene(source: string): Promise<string> {
  const compressed = await compressData(new TextEncoder().encode(source), {});
  return Buffer.from(compressed).toString("base64");
}

async function decodeScene(source: string): Promise<string> {
  const { data } = await decompressData<Record<string, never>>(
    new Uint8Array(Buffer.from(source, "base64")),
    { decryptionKey: "" },
  );
  return new TextDecoder().decode(data);
}

function legacyScene(options?: { readonly image?: boolean }): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: options?.image
      ? [
          {
            id: "image-element",
            type: "image",
            isDeleted: false,
            fileId: "image-file",
          },
        ]
      : [{ id: "shape", type: "rectangle", isDeleted: false }],
    appState: {
      name: "Converge me",
      theme: "dark",
      viewBackgroundColor: "#111111",
    },
    files: {},
  });
}

describe("whiteboard database convergence", () => {
  beforeEach(() => {
    Object.values(databaseMocks).forEach((mock) => mock.mockReset());
    databaseMocks.updateScene.mockReturnValue({
      set: databaseMocks.setScene,
    });
    databaseMocks.setScene.mockReturnValue({
      where: databaseMocks.whereScene,
    });
    databaseMocks.whereScene.mockReturnValue({
      returning: databaseMocks.returnScene,
    });
  });

  it("prepares a canonical V2 replacement without changing row semantics", async () => {
    const source = legacyScene();
    const prepared = await prepareWhiteboardSceneConvergence({
      id: "6f39b59d-d877-4fa8-9a74-a4c5d52c51b3",
      revision: 7,
      sceneData: await encodeScene(source),
      documentVersion: null,
      fileRecords: [],
    });

    expect(prepared.candidate).toBe(true);
    expect(prepared.audit).toMatchObject({
      revision: 7,
      sourceFormat: "legacy-excalidraw",
      elementCount: 1,
      referencedAssetCount: 0,
    });
    expect(prepared.audit.rowHash).not.toContain(
      "6f39b59d-d877-4fa8-9a74-a4c5d52c51b3",
    );
    const document = parseWhiteboardDocumentV2(
      await decodeScene(prepared.nextSceneData!),
    );
    expect(document).toMatchObject({
      version: 2,
      metadata: {
        name: "Converge me",
        theme: "dark",
        viewBackgroundColor: "#111111",
      },
    });
    expect(document.elements[0]).toMatchObject({
      id: "shape",
      type: "rectangle",
    });
  });

  it("hydrates and verifies externally stored asset metadata", async () => {
    const assetPayload = await compressData(
      new TextEncoder().encode("data:image/png;base64,AA=="),
      {
        metadata: {
          id: "image-file",
          mimeType: "image/png",
          created: 42,
        },
      },
    );
    const contentHash = createHash("sha256").update(assetPayload).digest("hex");
    const fetchAsset = vi.fn(
      async () => new Response(Uint8Array.from(assetPayload).buffer),
    );

    const prepared = await prepareWhiteboardSceneConvergence(
      {
        id: "56d896bc-a763-4b44-9188-39acb17f3471",
        revision: 2,
        sceneData: await encodeScene(legacyScene({ image: true })),
        documentVersion: 1,
        fileRecords: [
          {
            name: "image-file",
            url: "https://files.example/image",
            contentHash,
            createdAt: new Date("2026-07-27T00:00:00.000Z"),
          },
        ],
      },
      fetchAsset,
    );

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(
      parseWhiteboardDocumentV2(await decodeScene(prepared.nextSceneData!))
        .assets["image-file"],
    ).toEqual({
      id: "image-file",
      storage: "external",
      mimeType: "image/png",
      created: 42,
    });
  });

  it("validates a current V2 row using the newest duplicate asset record", async () => {
    const firstPayload = await compressData(
      new TextEncoder().encode("data:image/png;base64,AA=="),
      {
        metadata: {
          id: "image-file",
          mimeType: "image/png",
          created: 10,
        },
      },
    );
    const initial = await prepareWhiteboardSceneConvergence(
      {
        id: "9d1178e5-9f11-4e68-95d3-20ed04e89eb8",
        revision: 3,
        sceneData: await encodeScene(legacyScene({ image: true })),
        documentVersion: 1,
        fileRecords: [
          {
            name: "image-file",
            url: "https://files.example/first",
            contentHash: createHash("sha256")
              .update(firstPayload)
              .digest("hex"),
            createdAt: new Date("2026-07-26T00:00:00.000Z"),
          },
        ],
      },
      async () => new Response(Uint8Array.from(firstPayload).buffer),
    );
    const newerPayload = await compressData(
      new TextEncoder().encode("data:image/png;base64,AQ=="),
      {
        metadata: {
          id: "image-file",
          mimeType: "image/png",
          created: 99,
        },
      },
    );
    const fetchAsset = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      expect(url).toBe("https://files.example/newer");
      return new Response(Uint8Array.from(newerPayload).buffer);
    });

    const current = await prepareWhiteboardSceneConvergence(
      {
        id: "9d1178e5-9f11-4e68-95d3-20ed04e89eb8",
        revision: 4,
        sceneData: initial.nextSceneData,
        documentVersion: 2,
        fileRecords: [
          {
            name: "image-file",
            url: "https://files.example/older",
            contentHash: null,
            createdAt: new Date("2026-07-25T00:00:00.000Z"),
          },
          {
            name: "image-file",
            url: "https://files.example/newer",
            contentHash: createHash("sha256")
              .update(newerPayload)
              .digest("hex"),
            createdAt: new Date("2026-07-27T00:00:00.000Z"),
          },
        ],
      },
      fetchAsset,
    );

    expect(current.candidate).toBe(false);
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(
      parseWhiteboardDocumentV2(await decodeScene(current.nextSceneData!))
        .assets["image-file"],
    ).toMatchObject({ created: 10, mimeType: "image/png" });
  });

  it("refuses a conversion when a referenced external asset record is absent", async () => {
    await expect(
      prepareWhiteboardSceneConvergence({
        id: "4833236d-5875-42ac-9239-657543151c85",
        revision: 1,
        sceneData: await encodeScene(legacyScene({ image: true })),
        documentVersion: null,
        fileRecords: [],
      }),
    ).rejects.toThrow("MISSING_ASSET_RECORD");
  });

  it("backfills an empty draft without manufacturing a document payload", async () => {
    const prepared = await prepareWhiteboardSceneConvergence({
      id: "0157086d-2dc2-416d-9335-aee79b449383",
      revision: 1,
      sceneData: null,
      documentVersion: null,
      fileRecords: [],
    });

    expect(prepared).toMatchObject({
      candidate: true,
      nextSceneData: null,
      audit: {
        sourceFormat: "draft",
        payloadHashBefore: null,
        payloadHashAfter: null,
      },
    });
  });

  it("advances the scan cursor while exposing a separate retry cursor", async () => {
    databaseMocks.findScenes.mockResolvedValueOnce([
      {
        id: "0157086d-2dc2-416d-9335-aee79b449383",
        revision: 1,
        sceneData: "invalid",
        documentVersion: 1,
        fileRecords: [],
      },
      {
        id: "56d896bc-a763-4b44-9188-39acb17f3471",
        revision: 1,
        sceneData: "also-invalid",
        documentVersion: 1,
        fileRecords: [],
      },
    ]);

    const result = await runWhiteboardConvergenceBatch({
      apply: false,
      batchSize: 2,
      abortAfterFailures: 2,
    });

    expect(result).toMatchObject({
      stoppedAfterFailure: true,
      nextCursor: "56d896bc-a763-4b44-9188-39acb17f3471",
      retryFrom: null,
      hasMore: true,
    });
    expect(result.audits[0]).toMatchObject({ outcome: "failed" });
    expect(result.audits[1]).toMatchObject({ outcome: "failed" });
  });

  it("applies a draft backfill with the full compare-and-swap predicate", async () => {
    const id = "0157086d-2dc2-416d-9335-aee79b449383";
    databaseMocks.findScenes.mockResolvedValueOnce([
      {
        id,
        revision: 4,
        sceneData: null,
        documentVersion: 1,
        fileRecords: [],
      },
    ]);
    databaseMocks.returnScene.mockResolvedValueOnce([{ id }]);

    const result = await runWhiteboardConvergenceBatch({
      apply: true,
      batchSize: 1,
    });

    expect(result.audits[0]).toMatchObject({ outcome: "converted" });
    expect(databaseMocks.setScene).toHaveBeenCalledWith({
      sceneData: null,
      documentVersion: 2,
    });
    const predicate = databaseMocks.whereScene.mock.calls[0]?.[0] as unknown;
    expect(predicate).toBeInstanceOf(SQL);
    const query = new PgDialect().sqlToQuery(predicate as SQL);
    expect(query.sql).toContain('"revision"');
    expect(query.sql).toContain('"scene_data" is null');
    expect(query.sql).toContain('"document_version"');
    expect(query.params).toEqual(expect.arrayContaining([id, 4, 1]));
  });

  it("reports a compare-and-swap miss as a conflict", async () => {
    const id = "0157086d-2dc2-416d-9335-aee79b449383";
    databaseMocks.findScenes.mockResolvedValueOnce([
      {
        id,
        revision: 4,
        sceneData: null,
        documentVersion: 1,
        fileRecords: [],
      },
    ]);
    databaseMocks.returnScene.mockResolvedValueOnce([]);

    const result = await runWhiteboardConvergenceBatch({
      apply: true,
      batchSize: 1,
    });

    expect(result.audits[0]).toMatchObject({ outcome: "conflict" });
  });

  it("keeps unsupported conversion failures as a bounded audit code", async () => {
    databaseMocks.findScenes.mockResolvedValueOnce([
      {
        id: "0157086d-2dc2-416d-9335-aee79b449383",
        revision: 1,
        sceneData: await encodeScene(
          JSON.stringify({
            type: "excalidraw",
            version: 2,
            elements: [{ id: "unsupported", type: "video" }],
            appState: {},
            files: {},
          }),
        ),
        documentVersion: 1,
        fileRecords: [],
      },
    ]);

    const result = await runWhiteboardConvergenceBatch({
      apply: false,
      batchSize: 1,
    });

    expect(result.audits[0]).toMatchObject({
      outcome: "failed",
      errorCode: "UNSUPPORTED_ELEMENT",
    });
  });
});
