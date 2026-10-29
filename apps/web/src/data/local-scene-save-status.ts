// Per-tab status: only an actual scene write can clear a failed save.
let failed = false;
const listeners = new Set<() => void>();

export function setLocalSceneSaveFailed(next: boolean): void {
  if (failed === next) return;
  failed = next;
  for (const listener of listeners) listener();
}

export const getLocalSceneSaveFailed = () => failed;
export const getServerLocalSceneSaveFailed = () => false;

export function subscribeLocalSceneSaveStatus(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
