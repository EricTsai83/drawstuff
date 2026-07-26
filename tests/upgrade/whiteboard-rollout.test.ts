import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/config/app-constants";
import {
  importFromLocalStorage,
  saveOwnedWhiteboardDocumentToLocalStorage,
} from "@/data/local-storage";
import { saveToLocalStorage } from "@/lib/excalidraw";
import {
  classifyWhiteboardWriteTransition,
  createPersistedWhiteboardDocumentV1,
  evaluateWhiteboardRollout,
  parsePersistedWhiteboardPayload,
  prepareWhiteboardDocumentForOwnedEngine,
  serializeWhiteboardDocumentV1,
  stablePercentageBucket,
  type WhiteboardDocumentState,
  type WhiteboardElement,
  type WhiteboardRolloutConfig,
} from "@/features/whiteboard";

interface LegacyFixture {
  readonly elements: readonly WhiteboardElement[];
  readonly appState: WhiteboardDocumentState;
}

const baseConfig: WhiteboardRolloutConfig = {
  enabled: true,
  rollback: false,
  percentage: 0,
  internalEmails: new Set(["internal@drawstuff.test"]),
  forceOwnedSubjectIds: new Set(["force-owned"]),
  forceLegacySubjectIds: new Set(["force-legacy"]),
};

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

describe("whiteboard rollout targeting", () => {
  it("keeps explicit rollback and global rollback ahead of owned targeting", () => {
    expect(
      evaluateWhiteboardRollout(baseConfig, {
        subjectId: "force-legacy",
        email: "internal@drawstuff.test",
      }),
    ).toMatchObject({
      engine: "excalidraw",
      reason: "explicit-rollback",
    });
    expect(
      evaluateWhiteboardRollout(
        { ...baseConfig, rollback: true },
        { subjectId: "force-owned" },
      ),
    ).toMatchObject({
      engine: "excalidraw",
      reason: "global-rollback",
    });
  });

  it("targets internal users, explicit users, and stable percentage cohorts", () => {
    expect(
      evaluateWhiteboardRollout(baseConfig, {
        subjectId: "internal-user",
        email: " INTERNAL@drawstuff.test ",
      }).engine,
    ).toBe("owned");
    expect(
      evaluateWhiteboardRollout(baseConfig, {
        subjectId: "force-owned",
      }).engine,
    ).toBe("owned");

    const subjectId = "stable-session-user";
    const percentage = stablePercentageBucket(subjectId) + 1;
    const first = evaluateWhiteboardRollout(
      { ...baseConfig, percentage },
      { subjectId },
    );
    const second = evaluateWhiteboardRollout(
      { ...baseConfig, percentage },
      { subjectId },
    );
    expect(first).toEqual(second);
    expect(first.engine).toBe("owned");
  });

  it("keeps unsigned sessions on the adapter during percentage rollout", () => {
    expect(
      evaluateWhiteboardRollout({ ...baseConfig, percentage: 100 }, {}),
    ).toMatchObject({ engine: "excalidraw", reason: "unsigned" });
  });
});

describe("migration rollback safety", () => {
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

  it("writes only the owned local key and leaves rollback keys recoverable", () => {
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

    saveToLocalStorage(
      [
        {
          ...fixture.elements[0]!,
          id: "rollback-session-edit",
        },
      ] as unknown as Parameters<typeof saveToLocalStorage>[0],
      fixture.appState as Parameters<typeof saveToLocalStorage>[1],
      {},
      { syncOwnedDocument: false },
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
    const recovered = importFromLocalStorage({
      preferOwned: true,
      preferRecovery: true,
    });
    expect(recovered.elements[0]?.id).toBe("shape-1");
    expect(recovered.persistence?.loadedFromRecovery).toBe(true);
    expect(
      saveOwnedWhiteboardDocumentToLocalStorage({
        elements: recovered.elements,
        state: recovered.appState ?? {},
        assets: recovered.files,
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
    const existingOwned = serializeWhiteboardDocumentV1(
      createPersistedWhiteboardDocumentV1(parsed.document),
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
});
