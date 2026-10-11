// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";

const mocks = vi.hoisted(() => ({
  handleSceneSave: vi.fn(),
  rollbackSharedScene: vi.fn(),
  startUpload: vi.fn(),
  prepareSceneDataForExport: vi.fn(),
}));

vi.mock("@/server/actions", () => ({
  handleSceneSave: mocks.handleSceneSave,
  rollbackSharedScene: mocks.rollbackSharedScene,
}));
vi.mock("@/lib/uploadthing", () => ({
  useUploadThing: () => ({ startUpload: mocks.startUpload }),
}));
vi.mock("@/lib/export-scene-to-backend", () => ({
  prepareSceneDataForExport: mocks.prepareSceneDataForExport,
}));
vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return { useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }) };
});

const { useSceneExport } = await import("@/hooks/use-scene-export");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useSceneExport>;
let latest: Hook | undefined;
function Probe() {
  const hook = useSceneExport();
  useEffect(() => {
    latest = hook;
  }, [hook]);
  return null;
}

let root: Root | undefined;
const hook = (): Hook => {
  if (!latest) throw new Error("probe not mounted");
  return latest;
};
const elements = [{ id: "el" }] as unknown as ExcalidrawElement[];

beforeEach(() => {
  mocks.prepareSceneDataForExport.mockResolvedValue({
    encryptionKey: "key",
    compressedSceneData: new Uint8Array([1]),
    compressedFilesData: [{ id: "file-1", buffer: new Uint8Array([2]) }],
  });
  mocks.handleSceneSave.mockResolvedValue({
    sharedSceneId: "share-1",
    errorMessage: null,
    errorCode: null,
  });
  mocks.startUpload.mockResolvedValue([{ key: "k" }]);
  const container = document.createElement("div");
  root = createRoot(container);
  const mounted = root;
  act(() => mounted.render(<Probe />));
});

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  latest = undefined;
  vi.clearAllMocks();
});

describe("useSceneExport", () => {
  it("returns an encrypted share link when every upload succeeds", async () => {
    let link: string | null = null;
    await act(async () => {
      link = await hook().exportScene(elements, {}, {});
    });

    expect(link).toBe(`${window.location.origin}/#json=share-1,key`);
    expect(hook().exportStatus).toBe("success");
    expect(mocks.rollbackSharedScene).not.toHaveBeenCalled();
  });

  it("refuses a second export started before the first re-renders", async () => {
    let second: string | null = "unset";
    await act(async () => {
      const exportScene = hook().exportScene;
      const first = exportScene(elements, {}, {});
      second = await exportScene(elements, {}, {});
      await first;
    });

    expect(second).toBeNull();
    expect(mocks.handleSceneSave).toHaveBeenCalledOnce();
  });

  it("rolls the shared scene back when an upload rejects or throws", async () => {
    mocks.startUpload.mockImplementation(() => {
      throw new Error("sync failure");
    });
    let link: string | null = "unset";
    await act(async () => {
      link = await hook().exportScene(elements, {}, {});
    });

    expect(link).toBeNull();
    expect(mocks.rollbackSharedScene).toHaveBeenCalledWith("share-1");
    expect(hook().exportStatus).toBe("error");
  });

  it("rolls back when an upload resolves without exactly one file", async () => {
    mocks.startUpload.mockResolvedValue([]);
    await act(async () => {
      await hook().exportScene(elements, {}, {});
    });

    expect(mocks.rollbackSharedScene).toHaveBeenCalledWith("share-1");
  });
});
