// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPersistedWhiteboardDocumentV1,
  parsePersistedWhiteboardPayload,
  serializeWhiteboardDocumentV1,
  type WhiteboardDocument,
} from "@/features/whiteboard";
import { compressData, decompressData } from "@/lib/encode";
import { createPublicWhiteboardPayload } from "@/server/whiteboard/published-payload";
import { validateStoredWhiteboardWrite } from "@/server/whiteboard/persistence-guard";

const legacySource = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [
    {
      id: "legacy-shape",
      type: "rectangle",
      isDeleted: false,
    },
  ],
  appState: { name: "Legacy" },
  files: {},
});

const ownedDocument: WhiteboardDocument = {
  elements: [
    {
      id: "owned-image",
      type: "image",
      isDeleted: false,
      fileId: "owned-file",
    },
  ],
  state: { name: "Owned", theme: "light" },
  assets: {
    "owned-file": {
      id: "owned-file",
      dataURL: "data:image/png;base64,AA==",
      mimeType: "image/png",
      created: 1,
    },
  },
  persistence: {
    sourceFormat: "whiteboard-v1",
    documentVersion: 1,
    legacyRollback: {
      format: "excalidraw",
      sourceVersion: 2,
      migrationVersion: 1,
      originalPayload: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: { name: "Private rollback" },
        files: {
          "private-file": {
            id: "private-file",
            dataURL: "data:image/png;base64,PRIVATE",
          },
        },
      }),
      unsupported: {},
    },
  },
};

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

describe("stored whiteboard persistence guard", () => {
  it("blocks only an owned-to-legacy downgrade", async () => {
    const ownedSource = serializeWhiteboardDocumentV1(
      createPersistedWhiteboardDocumentV1(ownedDocument),
    );
    const [ownedData, legacyData] = await Promise.all([
      encodeScene(ownedSource),
      encodeScene(legacySource),
    ]);

    await expect(
      validateStoredWhiteboardWrite(ownedData, legacyData),
    ).resolves.toBe("unsafe-downgrade");
    await expect(
      validateStoredWhiteboardWrite(legacyData, ownedData),
    ).resolves.toBe("safe");
    await expect(
      validateStoredWhiteboardWrite(ownedData, ownedData),
    ).resolves.toBe("safe");
    await expect(validateStoredWhiteboardWrite(null, ownedData)).resolves.toBe(
      "safe",
    );
    await expect(
      validateStoredWhiteboardWrite(null, "not-base64-scene-data"),
    ).resolves.toBe("invalid");
  });

  it("allows a valid owned recovery write over an undecodable current row", async () => {
    const ownedData = await encodeScene(
      serializeWhiteboardDocumentV1(
        createPersistedWhiteboardDocumentV1(ownedDocument),
      ),
    );

    await expect(
      validateStoredWhiteboardWrite("not-base64-scene-data", ownedData),
    ).resolves.toBe("safe");
  });

  it("fails closed when a legacy write cannot classify the current row", async () => {
    const legacyData = await encodeScene(legacySource);

    await expect(
      validateStoredWhiteboardWrite("not-base64-scene-data", legacyData),
    ).resolves.toBe("invalid");
  });
});

describe("public owned payload", () => {
  it("removes rollback content and inline assets before public delivery", async () => {
    const privateData = await encodeScene(
      serializeWhiteboardDocumentV1(
        createPersistedWhiteboardDocumentV1(ownedDocument),
      ),
    );
    const publicData = await createPublicWhiteboardPayload(privateData);
    expect(publicData).not.toBeNull();
    const publicSource = await decodeScene(publicData!);
    const persisted = parsePersistedWhiteboardPayload(publicSource, {
      allowMissingAssets: true,
    });
    expect(persisted.format).toBe("whiteboard-v1");
    if (persisted.format !== "whiteboard-v1") return;

    expect(persisted.document.metadata.legacy).toBeUndefined();
    expect(persisted.document.assets).toEqual({});
    expect(publicSource).not.toContain("PRIVATE");
    expect(publicSource).not.toContain("private-file");
  });
});
