import { describe, expect, it } from "vitest";

import { resolveSceneSyncAction, type SceneSyncAction } from "@/lib/scene-sync";

/**
 * The remote-revision check: given what this client last synced, what the
 * server now holds, and whether the canvas has unsaved edits, decide whether
 * to do nothing, silently refresh, or ask the user about a conflict.
 */
describe("resolveSceneSyncAction", () => {
  it.each<
    [
      label: string,
      localRevision: number | undefined,
      remoteRevision: number | undefined,
      isDirty: boolean,
      expected: SceneSyncAction,
    ]
  >([
    // No remote revision (deleted scene, API error): never act blindly.
    ["remote unknown, clean", 3, undefined, false, "noop"],
    ["remote unknown, dirty", 3, undefined, true, "noop"],
    ["both unknown, clean", undefined, undefined, false, "noop"],
    ["both unknown, dirty", undefined, undefined, true, "noop"],
    // No local revision: the remote copy is the only known truth.
    ["local unknown, clean", undefined, 1, false, "refresh_remote"],
    ["local unknown, dirty", undefined, 1, true, "prompt_conflict"],
    [
      "local unknown, remote at zero, clean",
      undefined,
      0,
      false,
      "refresh_remote",
    ],
    // Identical revisions: nothing changed remotely.
    ["identical, clean", 5, 5, false, "noop"],
    ["identical, dirty", 5, 5, true, "noop"],
    ["both zero, dirty", 0, 0, true, "noop"],
    // Local ahead (e.g. a save that has not been acknowledged in state yet).
    ["local ahead, clean", 6, 5, false, "noop"],
    ["local ahead, dirty", 6, 5, true, "noop"],
    // Remote ahead: refresh when safe, otherwise let the user decide.
    ["remote ahead by one, clean", 5, 6, false, "refresh_remote"],
    ["remote ahead by one, dirty", 5, 6, true, "prompt_conflict"],
    ["remote far ahead, clean", 1, 100, false, "refresh_remote"],
    ["remote far ahead, dirty", 1, 100, true, "prompt_conflict"],
    ["remote ahead of zero, clean", 0, 1, false, "refresh_remote"],
  ])("%s -> %s", (_label, localRevision, remoteRevision, isDirty, expected) => {
    expect(
      resolveSceneSyncAction({ localRevision, remoteRevision, isDirty }),
    ).toBe(expected);
  });

  it("is a pure function of its inputs", () => {
    const params = { localRevision: 2, remoteRevision: 3, isDirty: true };
    const first = resolveSceneSyncAction(params);
    expect(resolveSceneSyncAction(params)).toBe(first);
    expect(params).toEqual({
      localRevision: 2,
      remoteRevision: 3,
      isDirty: true,
    });
  });
});
