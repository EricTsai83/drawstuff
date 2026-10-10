import type { SyncedElement } from "@drawstuff/collaboration/protocol";

/** `idle`: nothing has changed since the session began, so nothing is unsaved. */
type RoomSaveStatus = "idle" | "pending" | "saving" | "saved" | "failed";
export type RoomSaveState = {
  status: RoomSaveStatus;
  revision: number | null;
  checksum: string | null;
  /**
   * Confirmed saves of this client's own edits during the session. A baseline
   * loaded on arrival or after a reconnect, and other people's edits, never
   * count — so "Saved" can be shown as news only when it is.
   */
  localSaves: number;
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

type ElementVersion = { version: number; nonce: number; deleted: boolean };
const versionsOf = (
  elements: readonly SyncedElement[],
): Map<string, ElementVersion> =>
  new Map(
    elements.map((element) => [
      element.id,
      {
        version: element.version,
        nonce: element.versionNonce,
        deleted: !!element.isDeleted,
      },
    ]),
  );
const sameVersion = (a: ElementVersion, b: ElementVersion): boolean =>
  a.version === b.version && a.nonce === b.nonce && a.deleted === b.deleted;

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
  /**
   * Provenance for "Saved": the element versions this client produced and has
   * not yet seen stored, diffed against the last scene it observed (remote
   * applies update the observation without counting as ours).
   */
  let observed = new Map<string, ElementVersion>();
  const pendingLocal = new Map<string, ElementVersion>();
  /** A local version was stored since the last counted save. */
  let localStored = false;
  let localSaves = 0;
  let lastState: RoomSaveState | undefined;
  const state = (): RoomSaveState => ({
    status:
      confirmedCoverage !== undefined &&
      snapshotCoverage(options.currentElements()) === confirmedCoverage
        ? "saved"
        : activity,
    revision,
    checksum,
    localSaves,
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
      observed = versionsOf(options.currentElements());
      if (activity !== "saving") activity = "pending";
      notify();
    },
    /** A change made on this client (not applied from the room). */
    localChanged() {
      const now = versionsOf(options.currentElements());
      for (const [id, version] of now) {
        const before = observed.get(id);
        if (!before || !sameVersion(before, version))
          pendingLocal.set(id, version);
      }
      observed = now;
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
      // Count a save only when the stored snapshot holds this client's own
      // versions; a version overwritten by a newer remote one was not saved
      // and is dropped without counting.
      const stored = versionsOf(elements);
      for (const [id, mine] of pendingLocal) {
        const kept = stored.get(id);
        if (kept ? sameVersion(kept, mine) : mine.deleted) {
          pendingLocal.delete(id);
          localStored = true;
        } else if (kept && kept.version > mine.version) {
          pendingLocal.delete(id);
        }
      }
      if (localStored && state().status === "saved") {
        localSaves += 1;
        localStored = false;
      }
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
