import type { UnrecoverableReason } from "@drawstuff/collaboration/recovery";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";

import type { SceneSyncBlock } from "@/lib/collab/collaboration-session";

/**
 * The room hook's state, as one machine.
 *
 * These eight fields used to be eight `useState`s mutated from six call sites,
 * which made the legal combinations implicit. The reducer makes each transition
 * a named event, and teardown one `torn-down` dispatch instead of eight resets.
 * Pure and React-free so the transitions can be tested directly.
 */

export type CollaborationRoomStatus =
  | "idle"
  /** Resolving unsaved local work before the canvas is handed to the room. */
  | "preparing"
  | "joining"
  | "connected"
  /**
   * Connected, but the canvas is past a locked size contract, so at least one
   * publish path has stopped carrying it. Never reported as `connected`: a canvas
   * that is not being published is exactly what "共編中" must not mean.
   * `errorMessage` states which path stopped and what to do about it.
   */
  | "sync-blocked"
  /** The connection dropped and the session is retrying with backoff. */
  | "reconnecting"
  /** Recovery stopped for a stated reason; `errorMessage` carries it. */
  | "failed"
  /**
   * The backend refused this account: only an `UNAUTHORIZED`/`FORBIDDEN`
   * verdict lands here. Everything else that can break a join — an offline
   * browser, a 5xx, a crypto failure — is `join-failed` below, because telling
   * a user with a dropped connection to go ask for access is wrong twice.
   */
  | "unauthorized"
  /**
   * The bootstrap join broke for a retryable reason (network, backend error,
   * session construction). Nothing says this client may not be here; opening
   * the link again is expected to work.
   */
  | "join-failed"
  /**
   * The shared join budget refused this client and the bounded wait ran out.
   *
   * Deliberately its own status rather than `unauthorized`: nothing is wrong
   * with this link or this account, and telling the user otherwise sends them
   * to ask for access they already have. Deliberately not `failed` either —
   * that status carries a `failureReason` from the recovery machine, and this
   * never reached a session.
   */
  | "rate-limited"
  /** The user declined to give up the current canvas, so no join happened. */
  | "cancelled"
  /** The link carries a room id but no usable end-to-end key. */
  | "missing-room-key";

/**
 * Why a session (or a join attempt) stopped for good. The recovery machine's
 * reasons plus the two verdicts only the pre-join key check can produce — a
 * link whose key fails the room's check value, and a room that has no check
 * value to verify against. Exposed alongside the human-readable message so UI
 * can key behaviour on the reason (the owner's snapshot-reset entry point
 * appears only for `unreadable-room`) without parsing message text.
 */
export type CollaborationFailureReason =
  UnrecoverableReason | "wrong-key-link" | "missing-key-check";

export type RoomState = {
  status: CollaborationRoomStatus;
  /** Set while `status` is `failed`; `null` otherwise. */
  failureReason: CollaborationFailureReason | null;
  role: RoomRole | null;
  errorMessage: string | null;
  /**
   * Set while the canvas is too large for a publish path; see `SceneSyncBlock`.
   *
   * Held separately from `status` rather than folded into it, because the two are
   * independent facts about the same session: a recovery notification arrives on
   * every phase change and would otherwise clear a block that is still true, and a
   * reconnect does not make an oversize canvas fit.
   */
  syncBlock: SceneSyncBlock | null;
  /**
   * Set once the room turns out to hold images this link cannot open.
   *
   * Its own state rather than part of `status` because the session is not
   * degraded: elements sync, the socket is fine, and calling this "共編中" is
   * honest. What is *not* honest is showing an incomplete canvas with no
   * explanation.
   */
  assetsUnreadable: boolean;
  /**
   * True from the moment the canvas is claimed until the session is torn down.
   *
   * Distinct from "connected", and that distinction is the point: the claim
   * is taken *before* the join token is minted and the key derived, so a status of
   * "connected" would leave a window in which the canvas already belongs to the
   * room while the editor still offers the actions that replace it.
   */
  ownsCanvas: boolean;
  /**
   * True once the app has withdrawn this connection's authorization and a new
   * grant has not arrived yet.
   *
   * The relay closes with `membership-revoked` both when a member is removed and
   * when their *role* is changed — a role change has to force a reconnect, because
   * the role travels in the token. So during that reconnect the role this state is
   * holding may no longer be the user's, and continuing to accept edits on the
   * strength of it is how a demoted editor produces work the reconnected viewer can
   * never publish: locally newer than the room, refused by the relay, permanently
   * divergent. A transient drop is different — the role is unchanged, so editing
   * continues and the offline queue carries it.
   */
  roleWithdrawn: boolean;
};

export const initialRoomState: RoomState = {
  status: "idle",
  failureReason: null,
  role: null,
  errorMessage: null,
  syncBlock: null,
  assetsUnreadable: false,
  ownsCanvas: false,
  roleWithdrawn: false,
};

/** The statuses a join can end in without a session or a failure reason. */
export type JoinBlockedStatus = Extract<
  CollaborationRoomStatus,
  | "unauthorized"
  | "join-failed"
  | "rate-limited"
  | "cancelled"
  | "missing-room-key"
>;

export type RoomStateAction =
  /** A join (or rejoin) attempt begins; any previous message is stale. */
  | { type: "join-started" }
  /** Resolving unsaved local work before the canvas is handed to the room. */
  | { type: "preparing-canvas" }
  /** The join stopped before a session existed, without a recovery reason. */
  | { type: "join-blocked"; status: JoinBlockedStatus; errorMessage: string }
  /** Terminal: a recovery reason or a pre-join key-check verdict. */
  | {
      type: "failed";
      reason: CollaborationFailureReason;
      errorMessage: string;
    }
  | { type: "canvas-claimed" }
  /** The start path failed after claiming; the claim was rolled back. */
  | { type: "canvas-released" }
  /** The server stated the role, so it is authoritative again. */
  | { type: "role-granted"; role: RoomRole }
  /** The app withdrew this connection's authorization mid-session. */
  | { type: "role-withdrawn" }
  | { type: "sync-block-changed"; block: SceneSyncBlock | null }
  | { type: "assets-unreadable" }
  /**
   * A non-terminal recovery phase change. The caller maps the phase to the
   * user-facing status (it knows whether this session has ever been live);
   * the transition clears any failure reason and message.
   */
  | {
      type: "recovery-progressed";
      status: Extract<
        CollaborationRoomStatus,
        "connected" | "idle" | "reconnecting" | "joining"
      >;
    }
  /** Effect cleanup: back to the initial state in one dispatch. */
  | { type: "torn-down" };

export function roomStateReducer(
  state: RoomState,
  action: RoomStateAction,
): RoomState {
  switch (action.type) {
    case "join-started":
      return { ...state, status: "joining", errorMessage: null };
    case "preparing-canvas":
      return { ...state, status: "preparing" };
    case "join-blocked":
      return {
        ...state,
        status: action.status,
        errorMessage: action.errorMessage,
      };
    case "failed":
      return {
        ...state,
        status: "failed",
        failureReason: action.reason,
        errorMessage: action.errorMessage,
      };
    case "canvas-claimed":
      return { ...state, ownsCanvas: true };
    case "canvas-released":
      return { ...state, ownsCanvas: false };
    case "role-granted":
      return { ...state, role: action.role, roleWithdrawn: false };
    case "role-withdrawn":
      return { ...state, roleWithdrawn: true };
    case "sync-block-changed":
      return { ...state, syncBlock: action.block };
    case "assets-unreadable":
      return { ...state, assetsUnreadable: true };
    case "recovery-progressed":
      return {
        ...state,
        status: action.status,
        failureReason: null,
        errorMessage: null,
      };
    case "torn-down":
      return initialRoomState;
  }
}
