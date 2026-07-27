import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  importFromLocalStorage,
  saveOwnedWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import {
  classifyWhiteboardWriteTransition,
  createPersistedWhiteboardDocumentV1,
  parsePersistedWhiteboardPayload,
  prepareWhiteboardDocumentForOwnedEngine,
  serializeWhiteboardDocumentV1,
  type WhiteboardDocumentState,
  type WhiteboardElement,
} from "@/features/whiteboard";
import { createInitialWhiteboardDocument } from "@/lib/whiteboard";

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
  it("retains the exact legacy payload while owned edits advance independently", () => {
    const source = legacyPayload();
    const parsed = parsePersistedWhiteboardPayload(source);
    if (parsed.format !== "legacy-excalidraw") {
      throw new Error("Expected a legacy fixture");
    }
    const migrated = prepareWhiteboardDocumentForOwnedEngine(parsed.document);
    const edited = {
      ...migrated,
      elements: [
        ...migrated.elements,
        {
          id: "owned-edit",
          type: "ellipse",
          isDeleted: false,
        },
      ],
    };
    const persisted = createPersistedWhiteboardDocumentV1(edited);

    expect(persisted.metadata.legacy?.originalPayload).toBe(source);
    expect(persisted.elements.map((element) => element.id)).toEqual([
      "shape-1",
      "owned-edit",
    ]);
    expect(classifyWhiteboardWriteTransition(source, persisted)).toBe("safe");
    expect(classifyWhiteboardWriteTransition(persisted, source)).toBe(
      "unsafe-downgrade",
    );
  });

  it("writes only the owned local key and leaves rollback keys recoverable", async () => {
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

    const parsed = parsePersistedWhiteboardPayload(source);
    if (parsed.format !== "legacy-excalidraw") {
      throw new Error("Expected a legacy fixture");
    }
    const migrated = prepareWhiteboardDocumentForOwnedEngine(parsed.document);
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
    expect(ownedSource).toBe(
      serializeWhiteboardDocumentV1(
        createPersistedWhiteboardDocumentV1(migrated),
      ),
    );
    expect(saveOwnedWhiteboardDocumentToLocalStorage(migrated)).toBe(true);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBeNull();

    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([
        {
          ...fixture.elements[0]!,
          id: "rollback-session-edit",
        },
      ]),
    );
    const ownedRevision = Number(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_OWNED_DOCUMENT_REVISION),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_LEGACY_DOCUMENT_REVISION,
      Math.max(Date.now(), ownedRevision + 1).toString(),
    );

    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe(ownedSource);
    expect(importFromLocalStorage({ preferOwned: true }).elements[0]?.id).toBe(
      "rollback-session-edit",
    );

    const rollbackSession = importFromLocalStorage({ preferOwned: true });
    const remigrated = prepareWhiteboardDocumentForOwnedEngine({
      elements: rollbackSession.elements,
      state: rollbackSession.appState ?? {},
      assets: rollbackSession.files,
    });
    expect(saveOwnedWhiteboardDocumentToLocalStorage(remigrated)).toBe(true);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBe(ownedSource);
    const recovered = await createInitialWhiteboardDocument({
      preferRecovery: true,
    });
    if (!recovered) throw new Error("Expected the recovery document");
    expect(recovered.elements[0]?.id).toBe("shape-1");
    expect(recovered.persistence?.loadedFromRecovery).toBe(true);
    expect(
      saveOwnedWhiteboardDocumentToLocalStorage({
        elements: recovered.elements,
        state: recovered.state,
        assets: recovered.assets,
        persistence: recovered.persistence,
      }),
    ).toBe(true);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBeNull();
  });

  it("keeps the current owned snapshot when parking recovery data fails", () => {
    const source = legacyPayload("Recovery quota");
    const parsed = parsePersistedWhiteboardPayload(source);
    if (parsed.format !== "legacy-excalidraw") {
      throw new Error("Expected a legacy fixture");
    }
    const previous = parsePersistedWhiteboardPayload(
      legacyPayload("Previous owned lineage"),
    );
    if (previous.format !== "legacy-excalidraw") {
      throw new Error("Expected a previous legacy fixture");
    }
    const existingOwned = serializeWhiteboardDocumentV1(
      createPersistedWhiteboardDocumentV1(previous.document),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      existingOwned,
    );

    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      expect(key).toBe(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT);
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      saveOwnedWhiteboardDocumentToLocalStorage(
        prepareWhiteboardDocumentForOwnedEngine(parsed.document),
      ),
    ).toBe(false);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT),
    ).toBe(existingOwned);
  });

  it("persists an incomplete image snapshot while preserving recovery data", () => {
    const previous = parsePersistedWhiteboardPayload(legacyPayload());
    if (previous.format !== "legacy-excalidraw") {
      throw new Error("Expected a legacy fixture");
    }
    const existingOwned = serializeWhiteboardDocumentV1(
      createPersistedWhiteboardDocumentV1(
        prepareWhiteboardDocumentForOwnedEngine(previous.document),
      ),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_DOCUMENT,
      existingOwned,
    );
    const parsed = parsePersistedWhiteboardPayload({
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "missing-image",
          type: "image",
          isDeleted: false,
          fileId: "missing-asset",
        },
      ],
      appState: {},
      files: {},
    });
    if (parsed.format !== "legacy-excalidraw") {
      throw new Error("Expected a legacy fixture");
    }
    const incomplete = prepareWhiteboardDocumentForOwnedEngine(parsed.document);
    expect(saveOwnedWhiteboardDocumentToLocalStorage(incomplete)).toBe(true);
    expect(
      localStorage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_WHITEBOARD_RECOVERY_DOCUMENT,
      ),
    ).toBe(existingOwned);
    expect(
      importFromLocalStorage({ preferOwned: true }).elements[0],
    ).toMatchObject({
      id: "missing-image",
      fileId: "missing-asset",
    });
  });
});
