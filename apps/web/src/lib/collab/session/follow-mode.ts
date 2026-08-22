import type { PeerId, PresenceMessage } from "@drawstuff/collaboration/protocol";

/**
 * Follow-mode graph rules, kept pure so they can be tested without a session.
 *
 * Every client states in presence which peer it follows and when that follow
 * started (`follow: { peerId, since }`). Follow relations must stay acyclic:
 * a cycle (A→B→A, or A→B→C→A) would make every member chase the others'
 * previous viewport and the room would never settle. The product rule is
 * "the last actor decides the direction": when a new follow closes a cycle,
 * the *oldest* edge in that cycle releases and the newest one stays — for two
 * people that is exactly "B following A dissolves the earlier A following B".
 *
 * Each client only ever releases its own edge, so the rule is evaluated from
 * the local edge's point of view: "am I part of a cycle, and is my edge the
 * oldest one in it?". Every member sees the same graph through presence, so
 * all of them reach the same verdict; ties on the timestamp are broken by the
 * follower's peer id, which the members also agree on.
 */

export type FollowEdge = NonNullable<PresenceMessage["payload"]["follow"]>;

type EdgeIdentity = { follower: string; since: number };

/** Total order on edges: primarily the sender-stamped start time, tie-broken
 *  by follower id so every client ranks two same-instant follows alike. */
const isOlder = (a: EdgeIdentity, b: EdgeIdentity): boolean =>
  a.since < b.since || (a.since === b.since && a.follower < b.follower);

/**
 * True when this client's follow edge sits on a cycle and is the oldest edge
 * of that cycle — the one the product rule says must release.
 */
export function shouldReleaseFollow(params: {
  selfPeerId: PeerId;
  selfFollow: FollowEdge;
  /** Latest known follow edge per remote peer, from presence. */
  peerFollows: ReadonlyMap<PeerId, FollowEdge>;
}): boolean {
  const { selfPeerId, selfFollow, peerFollows } = params;
  let oldest: EdgeIdentity = { follower: selfPeerId, since: selfFollow.since };
  const visited = new Set<PeerId>([selfPeerId]);
  let current = selfFollow.peerId;
  // Follow the chain from our target. Out-degree is at most one per peer, so
  // this terminates at a peer with no edge, at a repeat (a cycle that does not
  // include us), or back at ourselves — the cycle the rule applies to.
  while (current !== selfPeerId) {
    if (visited.has(current)) return false;
    visited.add(current);
    const edge = peerFollows.get(current);
    if (!edge) return false;
    const identity: EdgeIdentity = { follower: current, since: edge.since };
    if (isOlder(identity, oldest)) oldest = identity;
    current = edge.peerId;
  }
  return oldest.follower === selfPeerId;
}
