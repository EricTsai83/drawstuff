// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  claimCanvasForRoom,
  releaseCanvasRoom,
} from "@/lib/collab/canvas-room-marker";
import {
  mocks,
  hook,
  mountProbe,
  unmountProbe,
  upload,
} from "./support/cloud-upload-harness";
import { STORAGE_KEYS } from "@/config/app-constants";
import { APP_ERROR } from "@/lib/errors";
import { collabImage } from "./support/collab-scene-fixtures";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.assign(mocks.session, {
    currentSceneId: "original",
    currentWorkspaceId: "ws",
    lastSyncedRevision: 3,
  });
  mocks.getCurrentSceneSnapshot.mockReturnValue({
    elements: [],
    appState: { name: "Room copy" },
    files: {},
  });
  mocks.prepareSceneDataForExport.mockResolvedValue({
    compressedSceneData: new Uint8Array([1]),
    compressedFilesData: [{ id: "image", buffer: new Uint8Array([2]) }],
  });
  mocks.createSceneDraft.mockResolvedValue({
    ok: true,
    data: { id: "copy", revision: 0 },
  });
  mocks.startAssetUpload.mockResolvedValue([{ key: "copy-asset" }]);
  mocks.startThumbnailUpload.mockResolvedValue([{ key: "copy-thumb" }]);
  mocks.exportSceneThumbnail.mockResolvedValue(new Blob(["png"]));
  mocks.saveScene.mockResolvedValue({
    ok: true,
    data: { id: "copy", revision: 1, isPublished: false },
  });
  mocks.readSceneAssetFileIds.mockResolvedValue({ ok: true, fileIds: [] });
  sessionStorage.setItem(
    STORAGE_KEYS.PERSONAL_DRAFT_BEFORE_ROOM,
    JSON.stringify({
      canvas: { elements: [], appState: { name: "Original name" }, files: {} },
      session: {
        [STORAGE_KEYS.CURRENT_SCENE_ID]: "original",
        [STORAGE_KEYS.CURRENT_SCENE_REVISION]: "3",
      },
    }),
  );
  claimCanvasForRoom("room");
  mountProbe();
});
afterEach(() => {
  unmountProbe();
  releaseCanvasRoom();
});

describe("explicit personal destinations inside a room", () => {
  it("creates a copy and independent assets without switching personal or room authority", async () => {
    expect(await upload({ roomAction: "copy", workspaceId: "copy-ws" })).toBe(
      true,
    );
    expect(mocks.createSceneDraft).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "copy-ws" }),
    );
    expect(mocks.startAssetUpload).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ sceneId: "copy" }),
    );
    expect(mocks.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({ id: "copy", expectedRevision: 0 }),
    );
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
    expect(mocks.session.markCurrentSceneDirty).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("excalidraw-collab-canvas-room-id")).toBe(
      "room",
    );
    expect(await upload({ roomAction: "copy", workspaceId: "copy-ws" })).toBe(
      true,
    );
    expect(mocks.createSceneDraft).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit destination instead of automatically updating the original", async () => {
    expect(await upload()).toBe(false);
    expect(mocks.saveScene).not.toHaveBeenCalled();
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
  });

  it("rejects a copy with unavailable images before creating a draft", async () => {
    mocks.getCurrentSceneSnapshot.mockReturnValue({
      elements: [collabImage({ id: "e", fileId: "missing" })],
      appState: {},
      files: {},
    });
    expect(await upload({ roomAction: "copy" })).toBe(false);
    expect(mocks.createSceneDraft).not.toHaveBeenCalled();
    expect(mocks.saveScene).not.toHaveBeenCalled();
  });

  it("a source with no preserved revision cannot adopt the current remote revision", async () => {
    sessionStorage.removeItem(STORAGE_KEYS.PERSONAL_DRAFT_BEFORE_ROOM);
    expect(
      await upload({ roomAction: "source", existingSceneId: "original" }),
    ).toBe(false);
    expect(mocks.saveScene).not.toHaveBeenCalled();
  });

  it("a source conflict retains room identity and uses a separate conflict destination", async () => {
    mocks.saveScene.mockResolvedValue({
      ok: false,
      error: APP_ERROR.SCENE_CONFLICT,
      data: { id: "original", revision: 9 },
    });
    expect(
      await upload({ roomAction: "source", existingSceneId: "original" }),
    ).toBe(false);
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem(STORAGE_KEYS.CURRENT_SCENE_REVISION),
    ).toBeNull();
    expect(sessionStorage.getItem("excalidraw-collab-canvas-room-id")).toBe(
      "room",
    );
  });

  it("updates only the explicitly selected source under its known revision", async () => {
    mocks.saveScene.mockResolvedValue({
      ok: true,
      data: { id: "original", revision: 4, isPublished: false },
    });
    expect(
      await upload({
        roomAction: "source",
        existingSceneId: "original",
        name: "Original name",
      }),
    ).toBe(true);
    expect(mocks.createSceneDraft).not.toHaveBeenCalled();
    expect(mocks.saveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "original",
        expectedRevision: 3,
        name: "Original name",
      }),
    );
    expect(mocks.session.syncCurrentScene).not.toHaveBeenCalled();
  });
});
