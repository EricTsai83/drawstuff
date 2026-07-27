import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shareExportMocks = vi.hoisted(() => ({
  handleSceneSave: vi.fn(),
  prepareSceneDataForExport: vi.fn(),
  rollbackSharedScene: vi.fn(),
  startUpload: vi.fn(),
}));

vi.mock("@/lib/export-scene-to-backend", () => ({
  prepareSceneDataForExport: shareExportMocks.prepareSceneDataForExport,
}));

vi.mock("@/server/actions", () => ({
  handleSceneSave: shareExportMocks.handleSceneSave,
  rollbackSharedScene: shareExportMocks.rollbackSharedScene,
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

describe("shared scene export", () => {
  beforeEach(() => {
    Object.values(shareExportMocks).forEach((mock) => mock.mockReset());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  });

  it("treats a scene containing only deleted legacy elements as empty", async () => {
    const hook = renderHook(() => useSceneExport());
    let link: string | null = "not-called";

    await act(async () => {
      link = await hook.result.current.exportScene(
        [
          {
            id: "deleted-image",
            type: "image",
            isDeleted: true,
            fileId: "private-asset",
          },
        ],
        { name: "Deleted legacy scene", theme: "light" },
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
});
