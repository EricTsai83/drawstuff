import type { SyncedElement } from "@drawstuff/collaboration/protocol";

/** `idle`: nothing has changed since the session began, so nothing is unsaved. */
type RoomSaveStatus = "idle" | "pending" | "saving" | "saved" | "failed";
export type RoomSaveState = {
  status: RoomSaveStatus;
  revision: number | null;
  checksum: string | null;
};

/**
 * Whether leaving a room loses nothing: nothing changed since the session
 * began, everything is confirmed, or this account cannot publish edits (a
 * viewer, or access withdrawn) — warning them would only block the way out.
 */
export function roomExitLosesNothing(options: {
  canEdit: boolean;
  status: RoomSaveStatus;
}): boolean {
  return (
    !options.canEdit || options.status === "saved" || options.status === "idle"
  );
}

/** Same identity contract as snapshotDigest, synchronous for leave guards. */
function snapshotCoverage(elements: readonly SyncedElement[]): string {
  return elements
    .map((element) =>
      JSON.stringify([
        element.id,
        element.version,
        element.versionNonce,
        element.isDeleted,
      ]),
    )
    .sort()
    .join("\n");
}

export function createRoomSaveState(options: {
  currentElements(): readonly SyncedElement[];
  onChange?: (state: RoomSaveState) => void;
}) {
  let confirmedCoverage: string | undefined;
  let revision: number | null = null;
  let checksum: string | null = null;
  let activity: "idle" | "pending" | "saving" | "failed" = "idle";
  let lastState: RoomSaveState | undefined;
  const state = (): RoomSaveState => ({
    status:
      confirmedCoverage !== undefined &&
      snapshotCoverage(options.currentElements()) === confirmedCoverage
        ? "saved"
        : activity,
    revision,
    checksum,
  });
  const notify = (): void => {
    const next = state();
    if (JSON.stringify(next) === JSON.stringify(lastState)) return;
    lastState = next;
    options.onChange?.(next);
  };
  return {
    state,
    invalidateConfirmation() {
      confirmedCoverage = undefined;
      notify();
    },
    changed() {
      if (activity !== "saving") activity = "pending";
      notify();
    },
    saving() {
      activity = "saving";
      notify();
    },
    failed() {
      activity = "failed";
      notify();
    },
    confirm(
      nextRevision: number,
      elements: readonly SyncedElement[],
      nextChecksum?: string,
    ) {
      if (revision !== null && nextRevision < revision) return;
      revision = nextRevision;
      checksum = nextChecksum ?? null;
      confirmedCoverage = snapshotCoverage(elements);
      activity = "pending";
      notify();
    },
    reset() {
      confirmedCoverage = undefined;
      revision = null;
      checksum = null;
      // Called on every reconnect: edits not yet saved are still unsaved.
      if (activity !== "idle") activity = "pending";
      notify();
    },
  };
}
