/** How far past a locked size contract the scene is, on one publish path. */
export type SceneSizeOverflow = {
  readonly byteLength: number;
  readonly maxByteLength: number;
};

/**
 * A publish path has stopped carrying this client's scene because the scene
 * exceeds the size contract that path is bound by.
 *
 * Reported rather than swallowed, because the failure is otherwise invisible and
 * does not heal on its own: nothing is marked sent, so the tracker keeps the same
 * pending set and the next `onChange` produces the identical refusal, while the
 * socket stays open and the session keeps looking connected. That is the one
 * shape of failure a user cannot discover — a canvas that quietly stops syncing
 * while the UI still says it is collaborating.
 *
 * The two paths are tracked separately because they fail independently and mean
 * different things: `realtime` is what the other members are no longer receiving,
 * `durable` is what a reload or a later joiner will no longer see. Neither is
 * terminal — both clear as soon as a send or a write is accepted, so removing
 * content restores sync without a reconnect.
 *
 * The size contracts are locked protocol/snapshot decisions and are not relaxed
 * here: this is what the client does once one of them is hit.
 */
export type SceneSyncBlock = {
  readonly realtime: SceneSizeOverflow | null;
  readonly durable: SceneSizeOverflow | null;
};

export type SyncBlockReporter = {
  /** Latches the realtime block; a repeat of an already-reported block is a no-op. */
  noteSceneSendRefusedAsOversize(overflow: SceneSizeOverflow): void;
  /** A scene message the transport accepted: the realtime path carries us again. */
  noteSceneSendAccepted(): void;
  noteSnapshotRefusedAsOversize(overflow: SceneSizeOverflow): void;
  noteSnapshotWritten(): void;
};

/**
 * Owns the two size-blocked publish paths; see `SceneSyncBlock`. Held as two
 * independent slots rather than one flag because a scene can breach the realtime
 * contract (1 MiB per message) and the durable one (4 MiB per snapshot)
 * separately, and the two clear on different events.
 *
 * `onChange` fires only on a *transition*, which is why the observed byte counts
 * are latched rather than refreshed. A blocked realtime path re-fails on every
 * single flush, and each attempt measures a few bytes differently — a new
 * `messageId`, a bumped sequence, a moved element — so reporting each measurement
 * would push a fresh object at the caller once per animation frame for a
 * condition that has not changed. The first measurement is the one worth keeping:
 * it is the size at which sync stopped, and the number exists to give the user a
 * sense of scale, not to track the canvas.
 */
export const createSyncBlockReporter = (
  onChange?: (block: SceneSyncBlock | null) => void,
): SyncBlockReporter => {
  let realtimeOverflow: SceneSizeOverflow | undefined;
  let durableOverflow: SceneSizeOverflow | undefined;

  const notify = (): void => {
    onChange?.(
      realtimeOverflow || durableOverflow
        ? {
            realtime: realtimeOverflow ?? null,
            durable: durableOverflow ?? null,
          }
        : null,
    );
  };

  return {
    noteSceneSendRefusedAsOversize(overflow) {
      if (realtimeOverflow) return;
      realtimeOverflow = overflow;
      notify();
    },
    noteSceneSendAccepted() {
      if (!realtimeOverflow) return;
      realtimeOverflow = undefined;
      notify();
    },
    noteSnapshotRefusedAsOversize(overflow) {
      if (durableOverflow) return;
      durableOverflow = overflow;
      notify();
    },
    noteSnapshotWritten() {
      if (!durableOverflow) return;
      durableOverflow = undefined;
      notify();
    },
  };
};
