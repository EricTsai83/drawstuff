import { beforeEach, describe, expect, it } from "vitest";

import { peerIdSchema } from "@drawstuff/collaboration/protocol";
import { createFakeCollaborationNetwork } from "@drawstuff/collaboration/testing";

import {
  COLLAB_SCENE_FIXED_NOW,
  collabAppState,
  collabRectangle,
  editedElement,
  sortSceneById,
} from "./support/collab-scene-fixtures";
import {
  AUTH_GENERATION,
  createHarness,
  createManualScheduler,
  createRawSender,
  createSceneHost,
  expectConverged,
  JOIN_TOKEN,
  peerIdOf,
  ROOM_ID,
  type TestClient,
} from "./support/collab-session-harness";
import { createCollaborationSession } from "@/lib/collab/collaboration-session";
import type { ConnectionState } from "@drawstuff/collaboration/transport";

describe("collaboration session over the fake network", () => {
  let harness: ReturnType<typeof createHarness>;
  let alice: TestClient;
  let bob: TestClient;

  beforeEach(() => {
    harness = createHarness();
    alice = harness.createClient("client-alice");
    bob = harness.createClient("client-bob");
    alice.session.connect();
    bob.session.connect();
    harness.settle();
  });

  it("converges add, move, style change and delete across two clients", () => {
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    expect(bob.host.elements).toHaveLength(1);
    expectConverged(alice, bob);

    bob.edit((elements) =>
      elements.map((element) =>
        element.id === "r1"
          ? editedElement(element, { x: 120, y: 40 })
          : element,
      ),
    );
    harness.network.flush();
    expectConverged(alice, bob);
    expect(alice.host.elements[0]).toMatchObject({ x: 120, y: 40, version: 2 });

    alice.edit((elements) =>
      elements.map((element) =>
        element.id === "r1"
          ? editedElement(element, { backgroundColor: "#ffc9c9" })
          : element,
      ),
    );
    harness.network.flush();
    expectConverged(alice, bob);
    expect(bob.host.elements[0]).toMatchObject({
      backgroundColor: "#ffc9c9",
      version: 3,
    });

    bob.edit((elements) =>
      elements.map((element) =>
        element.id === "r1"
          ? editedElement(element, { isDeleted: true })
          : element,
      ),
    );
    harness.network.flush();
    expectConverged(alice, bob);
    expect(alice.host.elements[0]).toMatchObject({ isDeleted: true });
  });

  it("applies every remote scene write outside the local undo history", () => {
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    bob.edit((elements) =>
      elements.map((element) => editedElement(element, { x: 9 })),
    );
    harness.network.flush();

    for (const client of [alice, bob]) {
      expect(client.host.elementCaptureUpdates.length).toBeGreaterThan(0);
      for (const captureUpdate of client.host.elementCaptureUpdates) {
        expect(captureUpdate).toBe("NEVER");
      }
    }
  });

  it("does not echo adopted remote elements back to the sender", () => {
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    expectConverged(alice, bob);

    // A no-op change notification on Bob's side (pointer-style onChange).
    bob.session.handleLocalSceneChange(bob.host.elements, collabAppState());
    bob.scheduler.runAll();
    expect(harness.network.pendingMessageCount()).toBe(0);
  });

  it("produces no scene message for pointer-only changes", () => {
    alice.session.handleLocalSceneChange(alice.host.elements, collabAppState());
    alice.scheduler.runAll();
    expect(harness.network.pendingMessageCount()).toBe(0);
  });

  it("hands a full snapshot to a late joiner", () => {
    alice.edit((elements) => [
      ...elements,
      collabRectangle({ id: "r1" }),
      collabRectangle({ id: "r2", isDeleted: true }),
    ]);
    harness.network.flush();

    const carol = harness.createClient("client-carol");
    carol.session.connect();
    harness.network.flush();
    // Carol's empty snapshot triggers snapshot replies; deliver them.
    harness.network.flush();

    expectConverged(alice, carol);
    expect(
      sortSceneById(carol.host.elements).map((element) => element.id),
    ).toEqual(["r1", "r2"]);
  });

  it("keeps only the newest state for duplicate and out-of-order messages", () => {
    const raw = createRawSender(harness.network);
    harness.network.flush(); // membership + snapshot exchange

    const base = collabRectangle({ id: "rx" });
    const v2 = editedElement(base, { x: 50 });

    // Newest first (sequence 2), then a stale sequence 1, then a duplicate.
    raw.transport.sendSceneMessage(
      raw.sceneMessage({ sequence: 2, elements: [v2] }),
    );
    harness.network.flush();
    raw.transport.sendSceneMessage(
      raw.sceneMessage({ sequence: 1, elements: [base] }),
    );
    raw.transport.sendSceneMessage(
      raw.sceneMessage({ sequence: 2, elements: [base] }),
    );
    harness.network.flush();

    const bobRx = bob.host.elements.find((element) => element.id === "rx");
    expect(bobRx).toMatchObject({ x: 50, version: 2 });
    const aliceRx = alice.host.elements.find((element) => element.id === "rx");
    expect(aliceRx).toMatchObject({ x: 50, version: 2 });
    expectConverged(alice, bob);
  });

  it("answers a detected sequence gap with a snapshot exchange", () => {
    const raw = createRawSender(harness.network);
    harness.network.flush();
    raw.received.length = 0;

    // Sequence 5 with no prior messages: receivers flag a gap and broadcast
    // their own snapshot, which invites the sender's snapshot reply.
    raw.transport.sendSceneMessage(
      raw.sceneMessage({
        sequence: 5,
        elements: [collabRectangle({ id: "rg" })],
      }),
    );
    harness.network.flush();
    harness.network.flush();

    const sceneInits = raw.received.filter(
      (message) => message.type === "scene-init",
    );
    expect(sceneInits.length).toBeGreaterThan(0);
    expectConverged(alice, bob);
  });

  it("keeps scene convergence when every presence message is dropped", () => {
    alice.session.handlePointerUpdate({
      pointer: { x: 10, y: 20, tool: "pointer" },
      button: "down",
      pointersMap: new Map(),
    });
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush({ dropPresenceMessages: true });

    expect(bob.host.collaborators.size).toBe(0);
    expectConverged(alice, bob);
    expect(bob.host.elements).toHaveLength(1);
  });

  it("publishes pointer, username and idle state through presence", () => {
    alice.session.handlePointerUpdate({
      pointer: { x: 10, y: 20, tool: "pointer" },
      button: "down",
      pointersMap: new Map(),
    });
    harness.network.flush();
    // Presence application is coalesced per frame; the manual scheduler is
    // that frame.
    bob.scheduler.runAll();

    const seenByBob = [...bob.host.collaborators.values()];
    expect(seenByBob).toHaveLength(1);
    expect(seenByBob[0]).toMatchObject({
      username: "client-alice",
      pointer: { x: 10, y: 20, tool: "pointer" },
      button: "down",
      userState: "active",
    });

    harness.clock.now += 40; // past the presence throttle window
    alice.session.setIdleState("idle");
    harness.network.flush();
    bob.scheduler.runAll();
    expect([...bob.host.collaborators.values()][0]).toMatchObject({
      userState: "idle",
    });
  });

  it("routes presence writes through the presence wrapper, not the remote-apply one", () => {
    const wraps: string[] = [];
    const carol = harness.createClient("client-carol", {
      wrapRemoteApply: (apply) => {
        wraps.push("remote");
        apply();
      },
      wrapPresenceApply: (apply) => {
        wraps.push("presence");
        apply();
      },
    });
    carol.session.connect();
    harness.settle();
    wraps.length = 0; // the join exchange applies scene state; not under test

    alice.session.handlePointerUpdate({
      pointer: { x: 10, y: 20, tool: "pointer" },
      button: "down",
      pointersMap: new Map(),
    });
    harness.network.flush();
    carol.scheduler.runAll();

    // The cursor landed, and only the presence path carried it: a host whose
    // remote-apply wrapper defers its cleanup by a frame must not have that
    // window opened ~30 times per second per peer for writes with no scene
    // state in them.
    expect(carol.host.collaborators.size).toBe(1);
    expect(wraps).toEqual(["presence"]);

    // Scene traffic still runs through the remote-apply wrapper.
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    expect(wraps).toContain("remote");
  });

  it("drops late presence from a departed peer instead of resurrecting its cursor", () => {
    alice.session.handlePointerUpdate({
      pointer: { x: 5, y: 5, tool: "pointer" },
      button: "up",
      pointersMap: new Map(),
    });
    expect(harness.network.pendingMessageCount()).toBe(1);

    // Membership updates synchronously while the presence frame is still
    // queued — the same shape as a decryption settling after the prune.
    alice.session.disconnect();
    harness.network.flush();
    expect(bob.host.collaborators.size).toBe(0);

    // A rejoin is a new peerId; the rebuilt cursor must be keyed by it alone,
    // with no stale entry left under the previous session's identity.
    alice.session.connect();
    harness.settle();
    alice.session.handlePointerUpdate({
      pointer: { x: 9, y: 9, tool: "pointer" },
      button: "up",
      pointersMap: new Map(),
    });
    harness.network.flush();
    bob.scheduler.runAll();
    expect([...bob.host.collaborators.keys()]).toEqual([peerIdOf(alice)]);
  });

  it("throttles pointer presence to the configured window", () => {
    const pointerUpdate = (x: number) =>
      alice.session.handlePointerUpdate({
        pointer: { x, y: 0, tool: "pointer" },
        button: "up",
        pointersMap: new Map(),
      });

    pointerUpdate(1);
    pointerUpdate(2);
    pointerUpdate(3);
    expect(harness.network.pendingMessageCount()).toBe(1);

    harness.clock.now += 33;
    pointerUpdate(4);
    expect(harness.network.pendingMessageCount()).toBe(2);
  });

  describe("follow mode", () => {
    type ViewBounds = [number, number, number, number];

    /** Records what the session asks the engine to do, in place of a canvas. */
    const createFollowRecorder = () => {
      const applied: ViewBounds[] = [];
      const followedBy: string[][] = [];
      let cleared = 0;
      return {
        applied,
        followedBy,
        get cleared() {
          return cleared;
        },
        host: {
          applyViewportBounds: (bounds: ViewBounds) => {
            applied.push([bounds[0], bounds[1], bounds[2], bounds[3]]);
          },
          clearFollowTarget: () => {
            cleared += 1;
          },
          applyFollowedBy: (peerIds: readonly string[]) => {
            followedBy.push([...peerIds]);
          },
        },
      };
    };

    const followPeer = (client: TestClient, target: TestClient) => {
      client.session.handleUserFollow(peerIdSchema.parse(peerIdOf(target)));
    };

    it("snaps to the target's cached viewport and tracks it as it moves", () => {
      const recorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
      });
      carol.session.connect();
      harness.settle();

      alice.session.handleViewportChange([10, 20, 110, 100]);
      harness.network.flush();
      // Not following yet: the bounds are cached, not applied.
      expect(recorder.applied).toEqual([]);

      followPeer(carol, alice);
      expect(recorder.applied).toEqual([[10, 20, 110, 100]]);
      // Alice's immediate reply re-delivers the same bounds; whether that
      // needs a canvas write is the host's call (it compares the fit against
      // the live viewport), so the channel hands it through.
      harness.settle();

      harness.clock.now += 40; // past the presence throttle window
      alice.session.handleViewportChange([50, 60, 150, 140]);
      harness.network.flush();
      expect(recorder.applied.at(-1)).toEqual([50, 60, 150, 140]);

      // Ending the follow stops the viewport from moving again.
      carol.session.handleUserFollow(null);
      const appliedCount = recorder.applied.length;
      harness.clock.now += 40;
      alice.session.handleViewportChange([0, 0, 10, 10]);
      harness.network.flush();
      expect(recorder.applied).toHaveLength(appliedCount);
    });

    it("answers a brand-new follower with an immediate viewport sample", () => {
      // Alice measured her viewport before Carol was in the room, so Carol
      // has nothing cached when the follow starts.
      alice.session.handleViewportChange([1, 2, 3, 4]);
      harness.network.flush();

      const recorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
      });
      carol.session.connect();
      harness.settle();

      followPeer(carol, alice);
      expect(recorder.applied).toEqual([]);
      // Carol's follow reaches Alice, who replies with presence at once even
      // though she is idle; the reply carries her current viewport.
      harness.settle();
      expect(recorder.applied).toEqual([[1, 2, 3, 4]]);
    });

    it("releases the older side of a mutual follow: the last actor decides", () => {
      const carolRecorder = createFollowRecorder();
      const daveRecorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: carolRecorder.host,
      });
      const dave = harness.createClient("client-dave", {
        followHost: daveRecorder.host,
      });
      carol.session.connect();
      dave.session.connect();
      harness.settle();

      followPeer(carol, dave);
      harness.settle();
      harness.clock.now += 10;
      followPeer(dave, carol);
      harness.settle();

      // Carol's earlier follow dissolved; Dave's newer one survives, so the
      // relation ends up one-way with no oscillation possible.
      expect(carolRecorder.cleared).toBe(1);
      expect(daveRecorder.cleared).toBe(0);
      // Carol announced the release, so Dave no longer counts her as a
      // follower; Carol now reports Dave as hers.
      expect(carolRecorder.followedBy.at(-1)).toEqual([peerIdOf(dave)]);
      expect(daveRecorder.followedBy.at(-1)).toEqual([]);
    });

    it("announces a pointer-less member's seeded viewport as soon as it connects", () => {
      const recorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
      });
      carol.session.connect();
      harness.settle();

      // The room session seeds the viewport before the socket finishes
      // connecting; a member who never touches the pointer must still be
      // followable from that seed alone.
      const dana = harness.createClient("client-dana");
      dana.session.handleViewportChange([5, 5, 25, 25]);
      dana.session.connect();
      harness.settle();

      followPeer(carol, dana);
      expect(recorder.applied).toEqual([[5, 5, 25, 25]]);
    });

    it("keeps the last actor's follow even when that client's clock lags", () => {
      const carolRecorder = createFollowRecorder();
      const daveRecorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: carolRecorder.host,
      });
      const dave = harness.createClient("client-dave", {
        followHost: daveRecorder.host,
      });
      carol.session.connect();
      dave.session.connect();
      harness.settle();

      followPeer(carol, dave);
      harness.settle();
      // Dave's wall clock now reads *earlier* than when Carol followed him.
      // His newer follow must still win: edges are stamped past every edge
      // already observed, not by the raw clock.
      harness.clock.now -= 1_000;
      followPeer(dave, carol);
      harness.settle();

      expect(carolRecorder.cleared).toBe(1);
      expect(daveRecorder.cleared).toBe(0);
    });

    it("breaks a three-member follow cycle by releasing only the oldest edge", () => {
      const recorders = {
        carol: createFollowRecorder(),
        dave: createFollowRecorder(),
        erin: createFollowRecorder(),
      };
      const carol = harness.createClient("client-carol", {
        followHost: recorders.carol.host,
      });
      const dave = harness.createClient("client-dave", {
        followHost: recorders.dave.host,
      });
      const erin = harness.createClient("client-erin", {
        followHost: recorders.erin.host,
      });
      carol.session.connect();
      dave.session.connect();
      erin.session.connect();
      harness.settle();

      followPeer(carol, dave);
      harness.settle();
      harness.clock.now += 5;
      followPeer(dave, erin);
      harness.settle();
      harness.clock.now += 5;
      followPeer(erin, carol);
      harness.settle();

      expect(recorders.carol.cleared).toBe(1);
      expect(recorders.dave.cleared).toBe(0);
      expect(recorders.erin.cleared).toBe(0);
    });

    it("stops following a peer that leaves the room", () => {
      const recorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
      });
      carol.session.connect();
      harness.settle();

      followPeer(carol, alice);
      harness.settle();
      expect(recorder.cleared).toBe(0);

      alice.session.disconnect();
      harness.settle();
      expect(recorder.cleared).toBe(1);
    });

    it("ignores viewport traffic once the canvas leaves the room", () => {
      const recorder = createFollowRecorder();
      let ownsCanvas = true;
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
        canSyncScene: () => ownsCanvas,
      });
      carol.session.connect();
      harness.settle();

      alice.session.handleViewportChange([10, 20, 110, 100]);
      harness.network.flush();
      followPeer(carol, alice);
      expect(recorder.applied).toHaveLength(1);
      harness.settle();
      const appliedCount = recorder.applied.length;

      // Another scene replaced Carol's canvas; the session is still connected
      // until React cleanup, but room traffic must neither move the new
      // canvas nor publish its viewport to the old room.
      ownsCanvas = false;
      harness.clock.now += 40;
      alice.session.handleViewportChange([50, 60, 150, 140]);
      harness.network.flush();
      expect(recorder.applied).toHaveLength(appliedCount);

      const pendingBefore = harness.network.pendingMessageCount();
      carol.session.handleViewportChange([9, 9, 99, 99]);
      expect(harness.network.pendingMessageCount()).toBe(pendingBefore);
    });

    it("sends the final viewport of a scroll once the throttle window closes", () => {
      const recorder = createFollowRecorder();
      const carol = harness.createClient("client-carol", {
        followHost: recorder.host,
      });
      carol.session.connect();
      harness.settle();

      followPeer(carol, alice);
      harness.settle(); // Alice's immediate reply opens her throttle window.

      // Both samples land inside the window: only a trailing send may carry
      // the final one — a follower stuck on the first would miss where the
      // scroll ended.
      alice.session.handleViewportChange([0, 0, 10, 10]);
      alice.session.handleViewportChange([0, 0, 20, 20]);
      harness.network.flush();
      expect(recorder.applied).toEqual([]);

      alice.timers.advance(33);
      harness.network.flush();
      expect(recorder.applied).toEqual([[0, 0, 20, 20]]);
    });
  });

  it("re-sends unacknowledged changes after an outbound queue overflow", () => {
    const tinyHarness = (() => {
      const network = createFakeCollaborationNetwork({ maxQueuedMessages: 1 });
      return network;
    })();
    const host = createSceneHost();
    const scheduler = createManualScheduler();
    const session = createCollaborationSession({
      transport: tinyHarness.createTransport(),
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
      authGeneration: AUTH_GENERATION,
      refreshJoinToken: () =>
        Promise.resolve({
          ok: true,
          token: JOIN_TOKEN,
          authGeneration: AUTH_GENERATION,
        }),
      username: "tiny",
      sceneApi: host.api,
      scheduleSceneFlush: scheduler.schedule,
      now: () => COLLAB_SCENE_FIXED_NOW,
    });
    const receiver = createSceneHost();
    const receiverScheduler = createManualScheduler();
    const receiverSession = createCollaborationSession({
      transport: tinyHarness.createTransport(),
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
      authGeneration: AUTH_GENERATION,
      refreshJoinToken: () =>
        Promise.resolve({
          ok: true,
          token: JOIN_TOKEN,
          authGeneration: AUTH_GENERATION,
        }),
      username: "rx",
      sceneApi: receiver.api,
      scheduleSceneFlush: receiverScheduler.schedule,
      now: () => COLLAB_SCENE_FIXED_NOW,
    });
    session.connect(); // join snapshot fills the 1-slot queue
    receiverSession.connect(); // this snapshot send overflows and stays pending

    host.setElements([collabRectangle({ id: "r1" })]);
    session.handleLocalSceneChange(host.elements, collabAppState());
    scheduler.runAll(); // overflow: nothing marked sent, retry scheduled
    expect(scheduler.pendingCount).toBeGreaterThan(0);

    tinyHarness.flush();
    scheduler.runAll();
    tinyHarness.flush();
    receiverScheduler.runAll();
    tinyHarness.flush();

    expect(
      receiver.elements.find((element) => element.id === "r1"),
    ).toBeDefined();
  });

  it("converges after disconnect, offline edits on both sides and rejoin", () => {
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    alice.session.handlePointerUpdate({
      pointer: { x: 1, y: 1, tool: "pointer" },
      button: "up",
      pointersMap: new Map(),
    });
    harness.network.flush();
    bob.scheduler.runAll();
    expect(bob.host.collaborators.size).toBe(1);

    alice.session.disconnect();
    harness.network.flush();
    // Bob prunes the departed collaborator's presence.
    expect(bob.host.collaborators.size).toBe(0);

    // Divergent offline edits: Bob moves r1, Alice recolors r1 and adds r2.
    bob.edit((elements) =>
      elements.map((element) =>
        element.id === "r1" ? editedElement(element, { x: 300 }) : element,
      ),
    );
    harness.network.flush();
    alice.edit((elements) => [
      ...elements.map((element) =>
        element.id === "r1"
          ? editedElement(element, { backgroundColor: "#a5d8ff" })
          : element,
      ),
      collabRectangle({ id: "r2" }),
    ]);
    expect(alice.session.getConnectionState().status).toBe("disconnected");

    alice.session.connect();
    harness.network.flush(); // join snapshots both ways
    harness.network.flush(); // convergence replies

    expectConverged(alice, bob);
    expect(
      sortSceneById(alice.host.elements).map((element) => element.id),
    ).toEqual(["r1", "r2"]);
  });

  it("cancels scheduled work and stops reacting after destroy", () => {
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();

    bob.host.setElements([
      ...bob.host.elements,
      collabRectangle({ id: "r-pending" }),
    ]);
    bob.session.handleLocalSceneChange(bob.host.elements, collabAppState());
    expect(bob.scheduler.pendingCount).toBe(1);

    bob.session.destroy();
    expect(bob.scheduler.pendingCount).toBe(0);
    expect(bob.scheduler.cancelledCount).toBe(1);

    // Destroyed sessions ignore local input and remote traffic alike.
    bob.session.handleLocalSceneChange(bob.host.elements, collabAppState());
    expect(bob.scheduler.pendingCount).toBe(0);
    const bobElementsBefore = bob.host.elements;
    alice.edit((elements) => [...elements, collabRectangle({ id: "r2" })]);
    harness.network.flush();
    expect(bob.host.elements).toBe(bobElementsBefore);
  });

  it("rebroadcasts a full snapshot once the sync interval elapses", () => {
    const raw = createRawSender(harness.network);
    harness.network.flush();
    raw.received.length = 0;

    harness.clock.now += 20_000;
    alice.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();

    expect(raw.received.some((message) => message.type === "scene-init")).toBe(
      true,
    );
    expectConverged(alice, bob);
  });
});

describe("viewer role", () => {
  it("sends no scene traffic but still receives, applies and reports presence", () => {
    const harness = createHarness();
    const editor = harness.createClient("client-editor");
    const viewer = harness.createClient("client-viewer", { role: "viewer" });
    editor.session.connect();
    viewer.session.connect();
    harness.network.flush();

    const state = viewer.session.getConnectionState();
    if (state.status !== "connected") throw new Error("viewer not connected");
    expect(state.role).toBe("viewer");

    // The editor's work still reaches the viewer's canvas.
    editor.edit((elements) => [...elements, collabRectangle({ id: "r1" })]);
    harness.network.flush();
    expect(viewer.host.elements.map((element) => element.id)).toEqual(["r1"]);

    // A local edit in a read-only session produces no outbound scene message,
    // so the session never gets itself disconnected by the relay's role check.
    viewer.edit((elements) => [
      ...elements,
      collabRectangle({ id: "r-viewer" }),
    ]);
    expect(harness.network.pendingMessageCount()).toBe(0);
    harness.network.flush();
    expect(editor.host.elements.map((element) => element.id)).toEqual(["r1"]);

    // Presence is not a scene mutation: a viewer's cursor is still shared.
    viewer.session.handlePointerUpdate({
      pointer: { x: 3, y: 4, tool: "pointer" },
      button: "up",
      pointersMap: new Map(),
    });
    expect(harness.network.pendingMessageCount()).toBe(1);
    harness.network.flush();
    editor.scheduler.runAll();
    expect(
      [...editor.host.collaborators.values()].map(
        (collaborator) => collaborator.username,
      ),
    ).toEqual(["client-viewer"]);
  });

  it("sends no join snapshot and answers no snapshot exchange as a viewer", () => {
    const harness = createHarness();
    const viewer = harness.createClient("client-viewer", { role: "viewer" });
    viewer.host.setElements([collabRectangle({ id: "local-only" })]);
    viewer.session.connect();
    // Even the join handshake snapshot is suppressed for a read-only role.
    expect(harness.network.pendingMessageCount()).toBe(0);

    const editor = harness.createClient("client-editor");
    editor.session.connect();
    harness.network.flush();
    // The editor's join snapshot arrives; the viewer holds state the snapshot
    // lacks but must not reply with its own.
    expect(harness.network.pendingMessageCount()).toBe(0);
  });
});

describe("scene attachment guard", () => {
  it("stops sending and applying scene state once the canvas holds another scene", () => {
    const network = createFakeCollaborationNetwork();
    const host = createSceneHost();
    const scheduler = createManualScheduler();
    let attached = true;
    const session = createCollaborationSession({
      transport: network.createTransport(),
      roomId: ROOM_ID,
      joinToken: JOIN_TOKEN,
      authGeneration: AUTH_GENERATION,
      refreshJoinToken: () =>
        Promise.resolve({
          ok: true,
          token: JOIN_TOKEN,
          authGeneration: AUTH_GENERATION,
        }),
      username: "attached",
      sceneApi: host.api,
      scheduleSceneFlush: scheduler.schedule,
      now: () => COLLAB_SCENE_FIXED_NOW,
      canSyncScene: () => attached,
    });
    const peer = createRawSender(network);
    session.connect();
    network.flush();

    // Detached: the canvas was replaced by a different scene. Local edits must
    // not be broadcast, or the room receives content from another document.
    attached = false;
    host.setElements([collabRectangle({ id: "other-scene" })]);
    session.handleLocalSceneChange(host.elements, collabAppState());
    scheduler.runAll();
    expect(network.pendingMessageCount()).toBe(0);

    // Inbound room state must not be written onto that other scene either.
    peer.transport.sendSceneMessage(
      peer.sceneMessage({
        type: "scene-init",
        sequence: 1,
        elements: [collabRectangle({ id: "from-room" })],
      }),
    );
    network.flush();
    expect(host.elements.map((element) => element.id)).toEqual(["other-scene"]);

    // Reattaching restores normal operation.
    attached = true;
    session.handleLocalSceneChange(host.elements, collabAppState());
    scheduler.runAll();
    expect(network.pendingMessageCount()).toBeGreaterThan(0);
  });
});

describe("connection state bookkeeping", () => {
  it("exposes the transport connection state", () => {
    const harness = createHarness();
    const client = harness.createClient("client-solo");
    const states: ConnectionState["status"][] = [];
    states.push(client.session.getConnectionState().status);
    client.session.connect();
    states.push(client.session.getConnectionState().status);
    client.session.disconnect();
    states.push(client.session.getConnectionState().status);
    expect(states).toEqual(["disconnected", "connected", "disconnected"]);
  });
});
