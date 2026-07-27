import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  importFromLocalStorage,
  saveOwnedWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import {
  convertPersistedWhiteboardDocumentToV2,
  parseWhiteboardDocumentForImport,
  parseWhiteboardDocumentV2,
  serializeWhiteboardDocumentV2,
  type WhiteboardDocumentState,
  type WhiteboardElement,
} from "@/features/whiteboard";

interface LegacyFixture {
  readonly elements: readonly WhiteboardElement[];
  readonly appState: WhiteboardDocumentState;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function legacyPayload(name = "Legacy board"): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      {
        id: "shape-1",
        type: "rectangle",
        isDeleted: false,
        x: 10,
        y: 20,
        width: 100,
        height: 60,
      },
    ],
    appState: {
      name,
      theme: "light",
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  });
}

describe("legacy migration recovery safety", () => {
  it("converts legacy content to V2 without retaining its source payload", () => {
    const source = legacyPayload();
    const converted = convertPersistedWhiteboardDocumentToV2(source);
    const serialized = serializeWhiteboardDocumentV2(converted.document);

    expect(converted.report.sourceFormat).toBe("legacy-excalidraw");
    expect(converted.document.elements.map((element) => element.id)).toEqual([
      "shape-1",
    ]);
    expect(serialized).not.toContain("originalPayload");
    expect(serialized).not.toContain("migrationVersion");
    expect(serialized).not.toContain(source);
  });

  it("writes only the V2 local key and never creates a recovery copy", () => {
    const source = legacyPayload("Rollback copy");
    const fixture = JSON.parse(source) as LegacyFixture;
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(fixture.elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(fixture.appState),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}");
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      "1",
    );

    const migrated = parseWhiteboardDocumentForImport(source);
    expect(saveOwnedWhiteboardDocumentToLocalStorage(migrated)).toBe(true);

    expect(importFromLocalStorage({ preferOwned: false }).appState?.name).toBe(
      "Rollback copy",
    );
    expect(importFromLocalStorage({ preferOwned: true }).appState?.name).toBe(
      "Rollback copy",
    );
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      JSON.stringify(fixture.elements),
    );

    const ownedSource = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
    );
    expect(parseWhiteboardDocumentV2(ownedSource).version).toBe(2);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBeNull();
  });

  it("keeps the current V2 snapshot when the canonical local write fails", () => {
    const previous = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Previous V2"),
    );
    const existingOwned = serializeWhiteboardDocumentV2(previous.document);
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      existingOwned,
    );

    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      expect(key).toBe(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT);
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      saveOwnedWhiteboardDocumentToLocalStorage(
        parseWhiteboardDocumentForImport(legacyPayload("Next V2")),
      ),
    ).toBe(false);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe(existingOwned);
  });

  it("refuses an incomplete image snapshot without replacing current V2", () => {
    const existingOwned = serializeWhiteboardDocumentV2(
      convertPersistedWhiteboardDocumentToV2(legacyPayload()).document,
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      existingOwned,
    );
    const incomplete = {
      elements: [
        {
          id: "missing-image",
          type: "image",
          isDeleted: false,
          fileId: "missing-asset",
        },
      ],
      state: {},
      assets: {},
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(saveOwnedWhiteboardDocumentToLocalStorage(incomplete)).toBe(false);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe(existingOwned);
  });
});
