import { readAdapterFixture } from "@drawstuff/excalidraw-adapter/testing";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import type { BinaryFiles } from "@drawstuff/excalidraw-adapter/types";
import { describe, expect, it, vi } from "vitest";

const { createJsonBlobMock, downloadMock, exportBlob } = vi.hoisted(() => ({
  createJsonBlobMock: vi.fn(),
  downloadMock: vi.fn(),
  exportBlob: {} as Blob,
}));

vi.mock("@/lib/base-url", () => ({
  getBaseUrl: () => "http://localhost:3000",
}));

vi.mock("@/lib/download", () => ({
  createJsonBlob: createJsonBlobMock.mockReturnValue(exportBlob),
  triggerBlobDownload: downloadMock,
}));

import { saveSceneJsonToDisk } from "@/lib/excalidraw";

type JsonObject = Record<string, unknown>;

const contractInput = readFixture<{
  appState: JsonObject;
  elements: JsonObject[];
  files: JsonObject;
}>("contract-input.json");
const expectedLocal = readFixture<JsonObject>("official-local.json");

describe("Excalidraw disk export", () => {
  it("downloads the official local format through the production writer", () => {
    saveSceneJsonToDisk(
      contractInput.elements as unknown as ExcalidrawElement[],
      contractInput.appState,
      contractInput.files as BinaryFiles,
    );

    expect(createJsonBlobMock).toHaveBeenCalledWith(expectedLocal);
    expect(downloadMock).toHaveBeenCalledWith("scene.excalidraw", exportBlob);
  });
});

function readFixture<T>(name: string): T {
  return readAdapterFixture<T>("excalidraw-0.18.1", name);
}
