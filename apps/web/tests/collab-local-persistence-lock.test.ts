import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isLocalScenePersistencePaused,
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";

/**
 * Holds are per tab and apply to every room canvas. Behavioral persistence and
 * restoration checks live in collab-local-persistence and collab-personal-draft.
 */

describe("local scene persistence lock", () => {
  beforeEach(() => {
    resumeLocalScenePersistence("collaboration-canvas");
  });

  it("suspends and resumes persistence", () => {
    expect(isLocalScenePersistencePaused()).toBe(false);
    pauseLocalScenePersistence("collaboration-canvas");
    expect(isLocalScenePersistencePaused()).toBe(true);
    resumeLocalScenePersistence("collaboration-canvas");
    expect(isLocalScenePersistencePaused()).toBe(false);
  });

  it("is idempotent in both directions", () => {
    pauseLocalScenePersistence("collaboration-canvas");
    pauseLocalScenePersistence("collaboration-canvas");
    resumeLocalScenePersistence("collaboration-canvas");
    // Keyed, not counted: one release ends one reason's hold exactly.
    expect(isLocalScenePersistencePaused()).toBe(false);
    resumeLocalScenePersistence("collaboration-canvas");
    expect(isLocalScenePersistencePaused()).toBe(false);
  });
});

describe("local scene persistence wiring", () => {
  const read = (relativePath: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

  it("takes the lock in the synchronous canvas handoff for every room", () => {
    expect(read("src/hooks/excalidraw/use-canvas-handoff.ts")).toContain(
      "preservePersonalDraft(",
    );
    expect(read("src/lib/collab/personal-draft.ts")).toContain(
      'pauseLocalScenePersistence("collaboration-canvas")',
    );
    expect(
      read("src/hooks/excalidraw/use-collaboration-room.ts"),
    ).not.toContain("if (!ownsCanvas || currentSceneId)");
  });
});
