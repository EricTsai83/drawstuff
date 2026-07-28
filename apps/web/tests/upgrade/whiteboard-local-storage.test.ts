import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeWhiteboardV3ResetNotice,
  importFromLocalStorage,
  saveOwnedWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import {
  loadWhiteboardSessionState,
  saveWhiteboardSessionState,
} from "@/data/local-storage";
import { createWhiteboardSessionStateV1 } from "@drawstuff/whiteboard";
import type { OwnedWhiteboardDocument } from "@drawstuff/whiteboard";
import { STORAGE_KEYS } from "@/config/app-constants";
import { rectangleV3 } from "../whiteboard-fixtures";

const document: OwnedWhiteboardDocument = {
  elements: [
    rectangleV3("local-shape", {
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      strokeColor: "#111111",
    }),
  ],
  assets: {},
  state: {
    name: "Local",
    theme: "dark",
    viewBackgroundColor: "#101010",
    gridSize: 20,
  },
};

describe("canonical local whiteboard storage", () => {
  it("resets only the corrupt session key", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      "document-stays",
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, "dark");
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_SESSION,
      "{broken",
    );

    expect(loadWhiteboardSessionState()).toEqual(
      createWhiteboardSessionStateV1(),
    );
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_SESSION),
    ).toBeNull();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe("document-stays");
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME)).toBe("dark");
  });

  it("persists the independent session payload", () => {
    const session = createWhiteboardSessionStateV1({
      activeTool: "arrow",
      openPanel: "properties",
    });
    expect(saveWhiteboardSessionState(session)).toBe(true);
    expect(loadWhiteboardSessionState()).toEqual(session);
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the current document", () => {
    expect(saveOwnedWhiteboardDocumentToLocalStorage(document)).toBe(true);

    const loaded = importFromLocalStorage();
    expect(loaded.elements).toHaveLength(1);
    expect(loaded.elements[0]).toMatchObject(document.elements[0]!);
    expect(loaded.appState).toEqual(document.state);
    expect(loaded.files).toEqual({});
  });

  it("returns an empty document for corrupt storage without throwing", () => {
    localStorage.setItem("drawstuff-whiteboard-document", "{not-json");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(importFromLocalStorage()).toEqual({
      elements: [],
      appState: null,
      files: {},
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("drops only a legacy V2 document and exposes a one-time notice", () => {
    localStorage.setItem(
      "drawstuff-whiteboard-document",
      JSON.stringify({ version: 2 }),
    );
    localStorage.setItem("theme", "dark");
    localStorage.setItem("currentSceneId", "remote-scene");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(importFromLocalStorage().elements).toEqual([]);
    expect(localStorage.getItem("drawstuff-whiteboard-document")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(consumeWhiteboardV3ResetNotice()).toBe(true);
    expect(consumeWhiteboardV3ResetNotice()).toBe(false);
  });
});
