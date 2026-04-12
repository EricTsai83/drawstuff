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
  if (remoteRevision === undefined) {
    return "refresh_remote";
  }

  if (localRevision === undefined) {
    return isDirty ? "prompt_conflict" : "refresh_remote";
  }

  if (remoteRevision <= localRevision) {
    return "noop";
  }

  return isDirty ? "prompt_conflict" : "refresh_remote";
}
