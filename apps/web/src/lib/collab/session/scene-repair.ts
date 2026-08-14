import type { SessionContext } from "@/lib/collab/session/session-context";

export type SceneRepair = {
  /** Arms the repair after a successful publish; see the factory doc. */
  arm(): void;
  /** Any sign that the room is still exchanging traffic re-earns the budget. */
  noteRoomActivity(): void;
  clear(): void;
};

/**
 * The repair that heals a publish nobody received.
 *
 * Every other repair path in the session is reactive: a sequence gap is noticed
 * when a *later* message from that sender arrives, a received snapshot draws a
 * reply, a newcomer draws a snapshot. All of them need traffic to happen next —
 * and the one case with no traffic next is the one that matters most. If the last
 * message of the room's activity is dropped and the room then goes quiet, the
 * sender has no acknowledgement to miss and the receiver sees no gap, so the
 * divergence is permanent.
 *
 * The throttled full resync was already meant to be that backstop, but it only
 * ran when a flush happened to occur, and an idle room never flushes. This puts
 * it on a timer, armed after *any* successful publish — a snapshot can be dropped
 * just as easily as a delta, so arming only after deltas would leave the same
 * hole one step further along.
 *
 * `maxAttempts` is what keeps that from becoming a permanent heartbeat. The
 * counter measures consecutive repairs with no sign of life in between: a local
 * edit or any inbound scene message resets it, because either one means the
 * reactive paths are working again. A room that goes completely silent therefore
 * emits a small bounded number of repairs and stops.
 */
export const createSceneRepair = (options: {
  context: Pick<SessionContext, "scheduleTimeout" | "isStopped">;
  maxAttempts: number;
  intervalMs: number;
  /** Late-bound: the publisher's coalesced flush. */
  requestFlush(): void;
}): SceneRepair => {
  const { context, maxAttempts, intervalMs } = options;
  /** Full-sync repair armed after the last publish. */
  let cancelSceneRepair: (() => void) | undefined;
  /** Consecutive timer-driven repairs with no room activity in between. */
  let sceneRepairAttempts = 0;

  return {
    arm() {
      if (sceneRepairAttempts >= maxAttempts) return;
      cancelSceneRepair?.();
      cancelSceneRepair = context.scheduleTimeout(() => {
        cancelSceneRepair = undefined;
        if (context.isStopped()) return;
        sceneRepairAttempts += 1;
        options.requestFlush();
      }, intervalMs);
    },
    noteRoomActivity() {
      sceneRepairAttempts = 0;
    },
    clear() {
      cancelSceneRepair?.();
      cancelSceneRepair = undefined;
    },
  };
};
