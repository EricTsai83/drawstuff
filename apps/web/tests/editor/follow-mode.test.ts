import { describe, expect, it } from "vitest";

import { peerIdSchema, type PeerId } from "@drawstuff/collaboration/protocol";

import {
  shouldReleaseFollow,
  type FollowEdge,
} from "@/lib/collab/session/follow-mode";

const peer = (id: string): PeerId => peerIdSchema.parse(id);
const A = peer("peer-a");
const B = peer("peer-b");
const C = peer("peer-c");

const follows = (
  entries: [PeerId, FollowEdge][],
): ReadonlyMap<PeerId, FollowEdge> => new Map(entries);

describe("follow-mode cycle rule", () => {
  it("keeps a follow that closes no cycle", () => {
    expect(
      shouldReleaseFollow({
        selfPeerId: A,
        selfFollow: { peerId: B, since: 1 },
        peerFollows: follows([[B, { peerId: C, since: 2 }]]),
      }),
    ).toBe(false);
  });

  it("releases the older edge of a mutual follow on both members' verdicts", () => {
    // A followed B first; B following A afterwards must dissolve A→B.
    expect(
      shouldReleaseFollow({
        selfPeerId: A,
        selfFollow: { peerId: B, since: 1 },
        peerFollows: follows([[B, { peerId: A, since: 2 }]]),
      }),
    ).toBe(true);
    expect(
      shouldReleaseFollow({
        selfPeerId: B,
        selfFollow: { peerId: A, since: 2 },
        peerFollows: follows([[A, { peerId: B, since: 1 }]]),
      }),
    ).toBe(false);
  });

  it("releases only the oldest edge of a three-member cycle", () => {
    // A→B (oldest), B→C, C→A (newest): only A releases.
    expect(
      shouldReleaseFollow({
        selfPeerId: A,
        selfFollow: { peerId: B, since: 1 },
        peerFollows: follows([
          [B, { peerId: C, since: 2 }],
          [C, { peerId: A, since: 3 }],
        ]),
      }),
    ).toBe(true);
    expect(
      shouldReleaseFollow({
        selfPeerId: B,
        selfFollow: { peerId: C, since: 2 },
        peerFollows: follows([
          [A, { peerId: B, since: 1 }],
          [C, { peerId: A, since: 3 }],
        ]),
      }),
    ).toBe(false);
    expect(
      shouldReleaseFollow({
        selfPeerId: C,
        selfFollow: { peerId: A, since: 3 },
        peerFollows: follows([
          [A, { peerId: B, since: 1 }],
          [B, { peerId: C, since: 2 }],
        ]),
      }),
    ).toBe(false);
  });

  it("breaks a same-instant tie by follower id, exactly one side releasing", () => {
    expect(
      shouldReleaseFollow({
        selfPeerId: A,
        selfFollow: { peerId: B, since: 5 },
        peerFollows: follows([[B, { peerId: A, since: 5 }]]),
      }),
    ).toBe(true);
    expect(
      shouldReleaseFollow({
        selfPeerId: B,
        selfFollow: { peerId: A, since: 5 },
        peerFollows: follows([[A, { peerId: B, since: 5 }]]),
      }),
    ).toBe(false);
  });

  it("ignores a cycle that does not include this client's edge", () => {
    expect(
      shouldReleaseFollow({
        selfPeerId: A,
        selfFollow: { peerId: B, since: 1 },
        peerFollows: follows([
          [B, { peerId: C, since: 2 }],
          [C, { peerId: B, since: 3 }],
        ]),
      }),
    ).toBe(false);
  });
});
