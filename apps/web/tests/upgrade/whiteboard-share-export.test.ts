import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shareExportMocks = vi.hoisted(() => ({
  handleSceneSave: vi.fn(),
  prepareSceneDataForExport: vi.fn(),
  cleanupFailedSharedScene: vi.fn(),
  startUpload: vi.fn(),
}));

vi.mock("@/lib/export-scene-to-backend", () => ({
  prepareSceneDataForExport: shareExportMocks.prepareSceneDataForExport,
}));

vi.mock("@/server/actions", () => ({
  handleSceneSave: shareExportMocks.handleSceneSave,
  cleanupFailedSharedScene: shareExportMocks.cleanupFailedSharedScene,
}));

vi.mock("@/lib/uploadthing", () => ({
  useUploadThing: () => ({
    startUpload: shareExportMocks.startUpload,
  }),
}));

vi.mock("@/lib/base-url", () => ({
  getBaseUrl: () => "https://drawstuff.example",
}));

import { useSceneExport } from "@/hooks/use-scene-export";
import { imageV3, rectangleV3 } from "../whiteboard-fixtures";

describe("shared scene export", () => {
  beforeEach(() => {
    Object.values(shareExportMocks).forEach((mock) => mock.mockReset());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  });

  it("treats a scene containing only deleted elements as empty", async () => {
    const hook = renderHook(() => useSceneExport());
    let link: string | null = "not-called";

    await act(async () => {
      link = await hook.result.current.exportScene(
        [
          imageV3("deleted-image", "private-asset", {
            isDeleted: true,
            width: 100,
            height: 100,
            strokeColor: "transparent",
            roughness: 0,
          }),
        ],
        { name: "Deleted scene", theme: "light" },
        {
          "private-asset": {
            id: "private-asset",
            dataURL: "data:image/png;base64,AA==",
            mimeType: "image/png",
            created: 1,
          },
        },
      );
    });

    expect(link).toBeNull();
    expect(hook.result.current.exportStatus).toBe("error");
    expect(hook.result.current.exportErrorMessage).toBe(
      "Cannot export empty canvas",
    );
    expect(shareExportMocks.prepareSceneDataForExport).not.toHaveBeenCalled();
    expect(shareExportMocks.handleSceneSave).not.toHaveBeenCalled();
    expect(shareExportMocks.startUpload).not.toHaveBeenCalled();
  });

  it("passes the canonical document version to the shared-scene write", async () => {
    const compressedSceneData = new Uint8Array([1, 2, 3]);
    shareExportMocks.prepareSceneDataForExport.mockResolvedValue({
      compressedSceneData,
      compressedFilesData: [],
      encryptionKey: "secret",
      documentVersion: 2,
    });
    shareExportMocks.handleSceneSave.mockResolvedValue({
      sharedSceneId: "shared-v2",
      errorMessage: null,
    });
    const hook = renderHook(() => useSceneExport());

    await act(async () => {
      await hook.result.current.exportScene(
        [rectangleV3("shape")],
        { name: "V2", theme: "light" },
        {},
      );
    });

    expect(shareExportMocks.handleSceneSave).toHaveBeenCalledWith(
      compressedSceneData,
      2,
    );
  });
});
