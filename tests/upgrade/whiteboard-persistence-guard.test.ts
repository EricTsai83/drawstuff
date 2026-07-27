// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
});

import {
  createPersistedWhiteboardDocumentV2,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  type OwnedWhiteboardDocument,
} from "@/features/whiteboard";
import { compressData, decompressData } from "@/lib/encode";
import { createPublicWhiteboardPayload } from "@/server/whiteboard/published-payload";
import { validateStoredWhiteboardWrite } from "@/server/whiteboard/persistence-guard";
import { validateOpaqueEncryptedWhiteboardWrite } from "@/server/whiteboard/persistence-guard";
import { SCENE_DATA_MAX_LENGTH } from "@/lib/schemas/scene";
import { scene, sharedScene } from "@/server/db/schema";

const ownedDocument: OwnedWhiteboardDocument = {
  elements: [
    {
      id: "owned-image",
      type: "image",
      isDeleted: false,
      fileId: "owned-file",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      opacity: 100,
      roughness: 0,
      locked: false,
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
  it("requires document_version metadata beside both opaque payloads", () => {
    expect(scene.documentVersion.name).toBe("document_version");
    expect(scene.documentVersion.notNull).toBe(true);
    expect(sharedScene.documentVersion.name).toBe("document_version");
    expect(sharedScene.documentVersion.notNull).toBe(true);
  });

  it("accepts only a valid V2 payload with the explicit current write version", async () => {
    const ownedSource = serializeWhiteboardDocumentV2(
      createPersistedWhiteboardDocumentV2(ownedDocument),
    );
    const ownedData = await encodeScene(ownedSource);

    await expect(validateStoredWhiteboardWrite(ownedData, 2)).resolves.toBe(
      "safe",
    );
    await expect(validateStoredWhiteboardWrite(ownedData, 1)).resolves.toBe(
      "stale-version",
    );
    await expect(
      validateStoredWhiteboardWrite(ownedData, undefined),
    ).resolves.toBe("stale-version");
    await expect(
      validateStoredWhiteboardWrite("not-base64-scene-data", 2),
    ).resolves.toBe("invalid");
  });

  it("checks only version and compressed size for opaque encrypted shares", () => {
    expect(validateOpaqueEncryptedWhiteboardWrite("opaque-ciphertext", 2)).toBe(
      "safe",
    );
    expect(validateOpaqueEncryptedWhiteboardWrite("opaque-ciphertext", 1)).toBe(
      "stale-version",
    );
    expect(
      validateOpaqueEncryptedWhiteboardWrite(
        "x".repeat(SCENE_DATA_MAX_LENGTH + 1),
        2,
      ),
    ).toBe("too-large");
  });

  it("does not inspect or depend on the previous row for a canonical write", async () => {
    const ownedData = await encodeScene(
      serializeWhiteboardDocumentV2(
        createPersistedWhiteboardDocumentV2(ownedDocument),
      ),
    );

    await expect(validateStoredWhiteboardWrite(ownedData, 2)).resolves.toBe(
      "safe",
    );
  });
});

describe("public owned payload", () => {
  it("emits V2 external assets without inline bytes", async () => {
    const privateData = await encodeScene(
      serializeWhiteboardDocumentV2(
        createPersistedWhiteboardDocumentV2(ownedDocument),
      ),
    );
    const publicData = await createPublicWhiteboardPayload(privateData);
    expect(publicData).not.toBeNull();
    const publicSource = await decodeScene(publicData!);
    const persisted = parseWhiteboardDocumentV2(publicSource);
    expect(persisted.version).toBe(2);
    expect(persisted.assets["owned-file"]).toMatchObject({
      id: "owned-file",
      storage: "external",
    });
    expect(publicSource).not.toContain("data:image/png");
  });

  it("refuses a well-formed document with a non-canonical field", async () => {
    const canonical = JSON.parse(
      serializeWhiteboardDocumentV2(
        createPersistedWhiteboardDocumentV2(ownedDocument),
      ),
    ) as { elements: Array<Record<string, unknown>> };
    canonical.elements[0]!.futureData = true;
    const invalidData = await encodeScene(JSON.stringify(canonical));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      createPublicWhiteboardPayload(invalidData),
    ).resolves.toBeNull();
    consoleError.mockRestore();
  });
});
