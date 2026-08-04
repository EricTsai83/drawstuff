import {
  MAX_JOIN_TOKEN_TTL_SECONDS,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
  type RoomChannelKey,
} from "@drawstuff/collaboration/room-auth";

/**
 * Registry of authorized, currently joined sessions plus the revocations that
 * must outlive them.
 *
 * Closing the sockets of a revoked member is not enough on its own: the member
 * still holds a signed join token that stays valid for the rest of its TTL and
 * would be accepted on an immediate reconnect. So a revocation is remembered as
 * a cutoff — the authorization revision the change produced — and every join
 * whose token was issued below that revision is refused.
 *
 * The cutoff is a revision, not a timestamp, because the app assigns revisions
 * under a row lock: a revocation that waited for the lock still outranks every
 * token issued before it, and a token issued after a re-grant always outranks
 * that re-grant's cutoff. Two consequences fall out for free — re-granting a
 * member works immediately, and a replayed revocation cannot close a session
 * that a later re-grant authorized.
 *
 * Cutoffs are still retired on a clock: once no token issued below a cutoff
 * could still be unexpired, the cutoff is redundant. Every mutation sweeps all
 * channels, so state stays bounded whether or not a given room sees traffic
 * again, and the relay keeps no durable authorization data.
 */
const CUTOFF_RETENTION_SECONDS =
  MAX_JOIN_TOKEN_TTL_SECONDS + ROOM_TOKEN_CLOCK_SKEW_SECONDS;

export type RelaySessionHandle = {
  /** Idempotent: safe to call from the socket's own close path. */
  release(): void;
};

/** Why the app asked the relay to drop a session. */
type RelaySessionClosure = "membership-revoked" | "room-ended";

export type RelaySessionRegistry = {
  register(session: {
    channel: RoomChannelKey;
    /** Authenticated user id from the verified join token (`sub`). */
    subject: string;
    /** Authorization revision (`arev`) of the join token presented. */
    tokenRevision: number;
    close: (closure: RelaySessionClosure) => void;
  }): RelaySessionHandle;
  /**
   * Refuses a join whose token predates a revocation or a room end. Called
   * before the socket reaches the fanout.
   */
  isRefused(
    channel: RoomChannelKey,
    subject: string,
    tokenRevision: number,
  ): boolean;
  /**
   * Closes every session of this member whose token was issued below
   * `cutoffRevision`, and refuses such tokens until they can no longer be
   * unexpired.
   */
  revokeMember(
    channel: RoomChannelKey,
    subject: string,
    cutoff: { revision: number; nowSeconds: number },
  ): number;
  /** Same for every member of the channel: the room generation is finished. */
  endChannel(
    channel: RoomChannelKey,
    cutoff: { revision: number; nowSeconds: number },
  ): number;
  sessionCount(): number;
  /** Live revocation cutoffs; bounded by room churn and retention. */
  cutoffCount(): number;
};

type RegisteredSession = {
  readonly subject: string;
  readonly tokenRevision: number;
  readonly close: (closure: RelaySessionClosure) => void;
};

/** A cutoff plus the moment it was recorded, which is what retires it. */
type Cutoff = { revision: number; recordedAtSeconds: number };

type ChannelState = {
  readonly sessions: Set<RegisteredSession>;
  /** Refuses every token below this revision, whoever presented it. */
  channelCutoff?: Cutoff;
  /** Per-member cutoffs. */
  readonly memberCutoffs: Map<string, Cutoff>;
};

export function createRelaySessionRegistry(options?: {
  now?: () => number;
}): RelaySessionRegistry {
  const now = options?.now ?? Date.now;
  const channels = new Map<RoomChannelKey, ChannelState>();

  const nowSeconds = (): number => Math.floor(now() / 1000);

  const stateOf = (channel: RoomChannelKey): ChannelState => {
    let state = channels.get(channel);
    if (!state) {
      state = { sessions: new Set(), memberCutoffs: new Map() };
      channels.set(channel, state);
    }
    return state;
  };

  const isRetired = (cutoff: Cutoff, horizonSeconds: number): boolean =>
    cutoff.recordedAtSeconds <= horizonSeconds;

  /**
   * Retires every cutoff no unexpired token could still be below, across all
   * channels: a room that never sees traffic again must not keep its entry
   * forever.
   */
  const sweep = (): void => {
    const horizon = nowSeconds() - CUTOFF_RETENTION_SECONDS;
    for (const [channel, state] of channels) {
      if (state.channelCutoff && isRetired(state.channelCutoff, horizon)) {
        state.channelCutoff = undefined;
      }
      for (const [subject, cutoff] of state.memberCutoffs) {
        if (isRetired(cutoff, horizon)) state.memberCutoffs.delete(subject);
      }
      if (
        state.sessions.size === 0 &&
        state.channelCutoff === undefined &&
        state.memberCutoffs.size === 0
      ) {
        channels.delete(channel);
      }
    }
  };

  const releaseIfEmpty = (
    channel: RoomChannelKey,
    state: ChannelState,
  ): void => {
    if (
      state.sessions.size > 0 ||
      state.channelCutoff !== undefined ||
      state.memberCutoffs.size > 0
    ) {
      return;
    }
    channels.delete(channel);
  };

  const remove = (
    channel: RoomChannelKey,
    session: RegisteredSession,
  ): void => {
    const state = channels.get(channel);
    if (!state?.sessions.delete(session)) return;
    releaseIfEmpty(channel, state);
  };

  /** Snapshot before closing: `close()` re-enters `release()` synchronously. */
  const closeMatching = (
    channel: RoomChannelKey,
    closure: RelaySessionClosure,
    matches: (session: RegisteredSession) => boolean,
  ): number => {
    const state = channels.get(channel);
    if (!state) return 0;
    let closed = 0;
    for (const session of [...state.sessions]) {
      if (!matches(session)) continue;
      remove(channel, session);
      session.close(closure);
      closed += 1;
    }
    return closed;
  };

  /** Cutoffs only ever move forward, so a replayed control call is a no-op. */
  const mergeCutoff = (existing: Cutoff | undefined, next: Cutoff): Cutoff =>
    existing === undefined || next.revision > existing.revision
      ? next
      : existing;

  return {
    register({ channel, subject, tokenRevision, close }) {
      const session: RegisteredSession = { subject, tokenRevision, close };
      stateOf(channel).sessions.add(session);
      return {
        release() {
          remove(channel, session);
        },
      };
    },
    isRefused(channel, subject, tokenRevision) {
      sweep();
      const state = channels.get(channel);
      if (!state) return false;
      if (
        state.channelCutoff !== undefined &&
        tokenRevision < state.channelCutoff.revision
      ) {
        return true;
      }
      const memberCutoff = state.memberCutoffs.get(subject);
      return (
        memberCutoff !== undefined && tokenRevision < memberCutoff.revision
      );
    },
    revokeMember(channel, subject, cutoff) {
      sweep();
      const state = stateOf(channel);
      const recorded: Cutoff = {
        revision: cutoff.revision,
        recordedAtSeconds: cutoff.nowSeconds,
      };
      state.memberCutoffs.set(
        subject,
        mergeCutoff(state.memberCutoffs.get(subject), recorded),
      );
      return closeMatching(
        channel,
        "membership-revoked",
        (session) =>
          session.subject === subject &&
          session.tokenRevision < cutoff.revision,
      );
    },
    endChannel(channel, cutoff) {
      sweep();
      const state = stateOf(channel);
      state.channelCutoff = mergeCutoff(state.channelCutoff, {
        revision: cutoff.revision,
        recordedAtSeconds: cutoff.nowSeconds,
      });
      return closeMatching(
        channel,
        "room-ended",
        (session) => session.tokenRevision < cutoff.revision,
      );
    },
    sessionCount() {
      let total = 0;
      for (const state of channels.values()) total += state.sessions.size;
      return total;
    },
    cutoffCount() {
      sweep();
      let total = 0;
      for (const state of channels.values()) {
        if (state.channelCutoff !== undefined) total += 1;
        total += state.memberCutoffs.size;
      }
      return total;
    },
  };
}
