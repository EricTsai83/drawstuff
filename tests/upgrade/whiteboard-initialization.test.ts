import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardDocument } from "@/features/whiteboard";

const initializationMocks = vi.hoisted(() => ({
  importDataFromBackend: vi.fn(),
  openConfirmModal: vi.fn(),
}));

vi.mock("@/lib/import-data-from-db", () => ({
  importDataFromBackend: initializationMocks.importDataFromBackend,
}));

vi.mock("@/lib/initialize-scene", () => ({
  openConfirmModal: initializationMocks.openConfirmModal,
}));

import { createInitialWhiteboardDocument } from "@/lib/whiteboard";

const sharedDocument: WhiteboardDocument = {
  elements: [
    {
      id: "shared-shape",
      type: "rectangle",
      isDeleted: false,
    },
  ],
  state: {
    name: "Shared scene",
    theme: "light",
  },
  assets: {},
};

describe("whiteboard initialization", () => {
  beforeEach(() => {
    initializationMocks.importDataFromBackend.mockReset();
    initializationMocks.openConfirmModal.mockReset();
    window.history.replaceState(
      {},
      document.title,
      "/#json=shared-scene,secret-key",
    );
  });

  it("retains a shared-link hash after a transient load failure", async () => {
    initializationMocks.importDataFromBackend.mockRejectedValue(
      new Error("Temporary network failure"),
    );
    const onFailure = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const loaded = await createInitialWhiteboardDocument({ onFailure });

    expect(loaded?.elements).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith("NETWORK");
    expect(window.location.hash).toBe("#json=shared-scene,secret-key");
  });

  it("clears a shared-link hash after the document loads successfully", async () => {
    initializationMocks.importDataFromBackend.mockResolvedValue(sharedDocument);

    const loaded = await createInitialWhiteboardDocument();

    expect(loaded?.elements[0]?.id).toBe("shared-shape");
    expect(window.location.hash).toBe("");
  });
});
