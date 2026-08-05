import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isLocalScenePersistencePaused,
  pauseLocalScenePersistence,
  resumeLocalScenePersistence,
} from "@/data/local-scene-persistence";

/**
 * Upstream stops caching the canvas locally for the whole collaboration session
 * (`LocalData.pauseSave("collaboration")`, `excalidraw-app/collab/Collab.tsx` at
 * 0.18.1). Drawstuff adopts the mechanism but not the blanket policy, and these
 * tests pin the lock's own semantics and the condition it is engaged under.
 * Whether a held lock actually stops the canvas being cached is covered
 * behaviourally in `collab-local-persistence.test.tsx`; the condition is asserted
 * structurally because reaching it needs the whole editor (tRPC, auth, a relay).
 */

describe("local scene persistence lock", () => {
  beforeEach(() => {
    resumeLocalScenePersistence("collaboration-guest-canvas");
  });

  it("suspends and resumes persistence", () => {
    expect(isLocalScenePersistencePaused()).toBe(false);
    pauseLocalScenePersistence("collaboration-guest-canvas");
    expect(isLocalScenePersistencePaused()).toBe(true);
    resumeLocalScenePersistence("collaboration-guest-canvas");
    expect(isLocalScenePersistencePaused()).toBe(false);
  });

  it("is idempotent in both directions", () => {
    pauseLocalScenePersistence("collaboration-guest-canvas");
    pauseLocalScenePersistence("collaboration-guest-canvas");
    resumeLocalScenePersistence("collaboration-guest-canvas");
    // Keyed, not counted: one release ends one reason's hold exactly.
    expect(isLocalScenePersistencePaused()).toBe(false);
    resumeLocalScenePersistence("collaboration-guest-canvas");
    expect(isLocalScenePersistencePaused()).toBe(false);
  });
});

describe("local scene persistence wiring", () => {
  const read = (relativePath: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

  it("engages the lock only for a room canvas with no owned scene behind it", () => {
    const source = read("src/hooks/excalidraw/use-collaboration-room.ts");
    // Both conditions matter. Dropping `ownsCanvas` would pause persistence for
    // every scene-less canvas; dropping `currentSceneId` would pause it for the
    // room owner too, whose stale cache a reload would restore and whose next
    // save would then upload over their newer cloud scene.
    expect(source).toContain("if (!ownsCanvas || currentSceneId) return;");
    expect(source).toContain(
      'pauseLocalScenePersistence("collaboration-guest-canvas")',
    );
    expect(source).toContain(
      'resumeLocalScenePersistence("collaboration-guest-canvas")',
    );
    // Re-evaluated when the guest saves a copy, so caching resumes once there is
    // an owned scene for the cache to be a cache of.
    expect(source).toContain("}, [ownsCanvas, currentSceneId]);");
  });

  it("keeps the local cache for the room owner", () => {
    const source = read("src/hooks/excalidraw/use-collaboration-room.ts");
    // Guard against the tempting simplification to upstream's blanket policy.
    expect(source).not.toContain("if (!ownsCanvas) return;");
  });
});
