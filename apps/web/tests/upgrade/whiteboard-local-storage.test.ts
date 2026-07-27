import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  importFromLocalStorage,
  saveOwnedWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import type { OwnedWhiteboardDocument } from "@drawstuff/whiteboard";

const document: OwnedWhiteboardDocument = {
  elements: [
    {
      id: "local-shape",
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
  state: {
    name: "Local",
    theme: "dark",
    viewBackgroundColor: "#101010",
    gridSize: 20,
  },
};

describe("canonical local whiteboard storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the current document", () => {
    expect(saveOwnedWhiteboardDocumentToLocalStorage(document)).toBe(true);

    expect(importFromLocalStorage()).toEqual({
      elements: document.elements,
      appState: document.state,
      files: {},
    });
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
});
