import { describe, expect, it } from "vitest";

import {
  initialRoomState,
  roomStateReducer,
  type JoinBlockedStatus,
  type RoomState,
  type RoomStateAction,
} from "@/lib/collab/room-state-reducer";

/**
 * The room hook's state machine. Every field of `liveState` is non-default so
 * each transition's claim to leave the rest untouched is actually checked.
 */
const liveState: RoomState = {
  status: "connected",
  failureReason: null,
  role: "editor",
  errorMessage: "stale message",
  syncBlock: {
    realtime: { byteLength: 2_048, maxByteLength: 1_024 },
    durable: null,
  },
  assetsUnreadable: true,
  ownsCanvas: true,
  roleWithdrawn: true,
};

const reduce = (state: RoomState, ...actions: RoomStateAction[]): RoomState =>
  actions.reduce(roomStateReducer, state);

describe("roomStateReducer", () => {
  it("starts idle with nothing claimed, granted, or blocked", () => {
    expect(initialRoomState).toEqual({
      status: "idle",
      failureReason: null,
      role: null,
      errorMessage: null,
      syncBlock: null,
      assetsUnreadable: false,
      ownsCanvas: false,
      roleWithdrawn: false,
    });
  });

  it.each<[RoomStateAction, Partial<RoomState>]>([
    [
      { type: "join-started" },
      { status: "joining", failureReason: null, errorMessage: null },
    ],
    [{ type: "preparing-canvas" }, { status: "preparing" }],
    [
      {
        type: "failed",
        reason: "membership-revoked",
        errorMessage: "You were removed",
      },
      {
        status: "failed",
        failureReason: "membership-revoked",
        errorMessage: "You were removed",
      },
    ],
    [
      { type: "failed", reason: "wrong-key-link", errorMessage: "Bad key" },
      {
        status: "failed",
        failureReason: "wrong-key-link",
        errorMessage: "Bad key",
      },
    ],
    [{ type: "canvas-claimed" }, { ownsCanvas: true }],
    [{ type: "canvas-released" }, { ownsCanvas: false }],
    [
      { type: "role-granted", role: "viewer" },
      { role: "viewer", roleWithdrawn: false },
    ],
    [{ type: "role-withdrawn" }, { roleWithdrawn: true }],
    [{ type: "sync-block-changed", block: null }, { syncBlock: null }],
    [
      {
        type: "sync-block-changed",
        block: {
          realtime: null,
          durable: { byteLength: 9, maxByteLength: 8 },
        },
      },
      {
        syncBlock: {
          realtime: null,
          durable: { byteLength: 9, maxByteLength: 8 },
        },
      },
    ],
    [{ type: "assets-unreadable" }, { assetsUnreadable: true }],
    [
      { type: "recovery-progressed", status: "reconnecting" },
      { status: "reconnecting", failureReason: null, errorMessage: null },
    ],
  ])("applies %j and leaves every other field alone", (action, expected) => {
    const next = roomStateReducer(liveState, action);
    expect(next).toEqual({ ...liveState, ...expected });
    expect(next).not.toBe(liveState);
  });

  it.each<JoinBlockedStatus>([
    "unauthorized",
    "join-failed",
    "rate-limited",
    "cancelled",
    "missing-room-key",
  ])("records a %s join block with its message", (status) => {
    const next = roomStateReducer(liveState, {
      type: "join-blocked",
      status,
      errorMessage: `blocked: ${status}`,
    });
    expect(next).toEqual({
      ...liveState,
      status,
      errorMessage: `blocked: ${status}`,
    });
  });

  it("returns the initial state object itself on teardown", () => {
    expect(roomStateReducer(liveState, { type: "torn-down" })).toBe(
      initialRoomState,
    );
  });

  it("clears a failure's reason and message once recovery progresses", () => {
    const failed = reduce(initialRoomState, {
      type: "failed",
      reason: "room-ended",
      errorMessage: "The room was ended",
    });
    expect(failed.failureReason).toBe("room-ended");

    const recovered = reduce(failed, {
      type: "recovery-progressed",
      status: "connected",
    });
    expect(recovered.status).toBe("connected");
    expect(recovered.failureReason).toBeNull();
    expect(recovered.errorMessage).toBeNull();
  });

  it("keeps a withdrawn role withdrawn until the server states it again", () => {
    const withdrawn = reduce(
      initialRoomState,
      { type: "role-granted", role: "editor" },
      { type: "role-withdrawn" },
    );
    expect(withdrawn).toMatchObject({ role: "editor", roleWithdrawn: true });

    // A transient recovery phase change is not a grant.
    const reconnecting = reduce(withdrawn, {
      type: "recovery-progressed",
      status: "reconnecting",
    });
    expect(reconnecting.roleWithdrawn).toBe(true);

    const regranted = reduce(reconnecting, {
      type: "role-granted",
      role: "viewer",
    });
    expect(regranted).toMatchObject({ role: "viewer", roleWithdrawn: false });
  });

  it("holds a sync block and unreadable-assets flag across recovery phases", () => {
    const blocked = reduce(
      initialRoomState,
      { type: "recovery-progressed", status: "connected" },
      {
        type: "sync-block-changed",
        block: {
          realtime: { byteLength: 3, maxByteLength: 2 },
          durable: null,
        },
      },
      { type: "assets-unreadable" },
      { type: "recovery-progressed", status: "reconnecting" },
      { type: "recovery-progressed", status: "connected" },
    );
    expect(blocked.syncBlock).toEqual({
      realtime: { byteLength: 3, maxByteLength: 2 },
      durable: null,
    });
    expect(blocked.assetsUnreadable).toBe(true);
  });

  it("walks the happy path from idle to connected and back", () => {
    const connected = reduce(
      initialRoomState,
      { type: "preparing-canvas" },
      { type: "canvas-claimed" },
      { type: "join-started" },
      { type: "role-granted", role: "owner" },
      { type: "recovery-progressed", status: "connected" },
    );
    expect(connected).toEqual({
      ...initialRoomState,
      status: "connected",
      role: "owner",
      ownsCanvas: true,
    });
    expect(reduce(connected, { type: "torn-down" })).toEqual(initialRoomState);
  });

  it("starts a retry clean: a failed run's reason does not outlive it", () => {
    const retried = reduce(
      liveState,
      { type: "failed", reason: "unreadable-room", errorMessage: "Bad key" },
      { type: "join-started" },
    );
    expect(retried).toMatchObject({
      status: "joining",
      failureReason: null,
      errorMessage: null,
    });
  });

  it("does not guard transitions: a claim rollback after a failure still applies", () => {
    // The reducer records events; the hook decides which ones to dispatch. So a
    // late `canvas-released` after `failed` must still be honoured, or a rolled
    // back claim would keep hiding the editor's replace-canvas actions.
    const next = reduce(
      liveState,
      { type: "failed", reason: "unauthorized", errorMessage: "No access" },
      { type: "canvas-released" },
    );
    expect(next).toMatchObject({ status: "failed", ownsCanvas: false });
  });
});
