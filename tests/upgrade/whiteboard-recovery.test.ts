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

  it("verifies the V2 local key before removing obsolete local keys", () => {
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

    expect(importFromLocalStorage({ preferOwned: true }).appState?.name).toBe(
      "Rollback copy",
    );
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION),
    ).toBeNull();

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

  it("retains every legacy key when conversion cannot write the V2 copy", () => {
    const fixture = JSON.parse(legacyPayload("Keep me")) as LegacyFixture;
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(fixture.elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(fixture.appState),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(importFromLocalStorage().elements).toEqual([]);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).not.toBeNull();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE),
    ).not.toBeNull();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBeNull();
  });

  it("still loads verified V2 when obsolete-key cleanup is interrupted", () => {
    const canonical = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Verified V2"),
    ).document;
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(canonical),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "[]");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "InvalidStateError");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(importFromLocalStorage().appState?.name).toBe("Verified V2");
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      "[]",
    );
  });

  it("loads recovery in isolation and consumes it only after an explicit save", () => {
    const canonical = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Current V2"),
    ).document;
    const canonicalSource = serializeWhiteboardDocumentV2(canonical);
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      canonicalSource,
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      legacyPayload("Recovery V2"),
    );

    const recovered = importFromLocalStorage({ preferRecovery: true });

    expect(recovered.appState?.name).toBe("Recovery V2");
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe(canonicalSource);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).not.toBeNull();
    expect(
      saveOwnedWhiteboardDocumentToLocalStorage({
        elements: recovered.elements,
        state: recovered.appState ?? {},
        assets: recovered.files,
        persistence: recovered.persistence,
      }),
    ).toBe(true);
    expect(
      parseWhiteboardDocumentV2(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
      ).metadata.name,
    ).toBe("Recovery V2");
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBeNull();
  });

  it("does not consume a parked recovery snapshot during an ordinary load", () => {
    const canonical = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Current V2"),
    ).document;
    const recoverySource = legacyPayload("Parked recovery");
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(canonical),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      recoverySource,
    );

    expect(importFromLocalStorage().appState?.name).toBe("Current V2");
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBe(recoverySource);
  });

  it("prefers a valid canonical document over stale legacy revision markers", () => {
    const canonical = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Current V2"),
    ).document;
    const legacy = JSON.parse(legacyPayload("Stale legacy")) as LegacyFixture;
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(canonical),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(legacy.elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(legacy.appState),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_FILES, "{}");
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      "9999999999999",
    );

    expect(importFromLocalStorage().appState?.name).toBe("Current V2");
    expect(
      parseWhiteboardDocumentV2(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
      ).metadata.name,
    ).toBe("Current V2");
  });

  it("does not delete invalid legacy keys merely because canonical V2 is valid", () => {
    const canonical = convertPersistedWhiteboardDocumentToV2(
      legacyPayload("Current V2"),
    ).document;
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      serializeWhiteboardDocumentV2(canonical),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([{ id: "legacy-shape", type: "rectangle" }]),
    );
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, "{invalid");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(importFromLocalStorage().appState?.name).toBe("Current V2");
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE)).toBe(
      "{invalid",
    );
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
