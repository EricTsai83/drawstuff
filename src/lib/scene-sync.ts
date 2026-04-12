export type SceneSyncAction = "noop" | "refresh_remote" | "prompt_conflict";

export type ResolveSceneSyncActionParams = {
  localRevision: number | undefined;
  remoteRevision: number | undefined;
  isDirty: boolean;
};

export function resolveSceneSyncAction({
  localRevision,
  remoteRevision,
  isDirty,
}: ResolveSceneSyncActionParams): SceneSyncAction {
  // Remote revision unavailable (e.g. scene deleted or API error) — nothing
  // actionable; the caller should not attempt a blind refresh.
  if (remoteRevision === undefined) {
    return "noop";
  }

  if (localRevision === undefined) {
    return isDirty ? "prompt_conflict" : "refresh_remote";
  }

  if (remoteRevision <= localRevision) {
    return "noop";
  }

  return isDirty ? "prompt_conflict" : "refresh_remote";
}
