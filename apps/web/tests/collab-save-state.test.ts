// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { SyncedElement } from "@drawstuff/collaboration/protocol";
import {
  createRoomSaveState,
  roomExitLosesNothing,
} from "@/lib/collab/session/save-state";
import {
  createHarness,
  createSnapshotBackend,
  createRawSender,
} from "./support/collab-session-harness";
import {
  collabImage,
  collabRectangle,
  editedElement,
} from "./support/collab-scene-fixtures";
import { drainAsync } from "./support/async-drain";

const settle = async (h: ReturnType<typeof createHarness>) => {
  for (let round = 0; round < 10; round++) {
    await drainAsync();
    if (!h.network.pendingMessageCount()) return;
    h.settle();
  }
  throw new Error("save exchange did not settle");
};

describe("durable room save coverage", () => {
  it("old and duplicate receipts cannot clear newer edits, conflicts or tombstones", () => {
    let current: readonly SyncedElement[] = [collabRectangle({ id: "a" })];
    const saved = [...current];
    const state = createRoomSaveState({ currentElements: () => current });
    state.confirm(1, saved, "old");
    expect(state.state().status).toBe("saved");
    current = [collabRectangle({ id: "a", version: 2, versionNonce: 3 })];
    state.changed();
    state.confirm(1, saved, "old");
    expect(state.state().status).toBe("pending");
    current = [
      collabRectangle({
        id: "a",
        version: 2,
        versionNonce: 4,
        isDeleted: true,
      }),
    ];
    state.confirm(2, [
      collabRectangle({ id: "a", version: 2, versionNonce: 4 }),
    ]);
    expect(state.state().status).toBe("pending");
    state.confirm(3, current);
    state.confirm(2, saved);
    expect(state.state()).toMatchObject({ status: "saved", revision: 3 });
    // A reconnect does not make unsaved edits saved.
    state.reset();
    expect(state.state().status).toBe("pending");
  });

  it("counts only confirmed saves of this client's own edits", () => {
    let current: readonly SyncedElement[] = [collabRectangle({ id: "a" })];
    const state = createRoomSaveState({ currentElements: () => current });
    // A baseline loaded on arrival is not this client's save.
    state.changed();
    state.confirm(1, current);
    expect(state.state()).toMatchObject({ status: "saved", localSaves: 0 });
    // Someone else's edit, saved by the writer: still not ours.
    current = [collabRectangle({ id: "a", version: 2, versionNonce: 2 })];
    state.changed();
    state.confirm(2, current);
    expect(state.state().localSaves).toBe(0);
    // Our own edit, confirmed: one save to show.
    current = [collabRectangle({ id: "a", version: 3, versionNonce: 3 })];
    state.localChanged();
    state.confirm(3, current);
    expect(state.state()).toMatchObject({ status: "saved", localSaves: 1 });
    // A later baseline without new edits of ours does not count again.
    state.reset();
    state.confirm(3, current);
    expect(state.state().localSaves).toBe(1);
  });

  it("does not count a local edit that a newer remote version replaced", () => {
    let current: readonly SyncedElement[] = [collabRectangle({ id: "a" })];
    const state = createRoomSaveState({ currentElements: () => current });
    state.changed();
    state.confirm(1, current);
    // Our edit (version 2), then a remote version 3 wins before any save.
    current = [collabRectangle({ id: "a", version: 2, versionNonce: 20 })];
    state.localChanged();
    current = [collabRectangle({ id: "a", version: 3, versionNonce: 30 })];
    state.changed();
    state.confirm(2, current);
    expect(state.state()).toMatchObject({ status: "saved", localSaves: 0 });
  });

  it("warns on leaving only an editor with unconfirmed changes", () => {
    expect(roomExitLosesNothing({ canEdit: true, status: "pending" })).toBe(
      false,
    );
    expect(roomExitLosesNothing({ canEdit: true, status: "failed" })).toBe(
      false,
    );
    expect(roomExitLosesNothing({ canEdit: true, status: "idle" })).toBe(true);
    expect(roomExitLosesNothing({ canEdit: true, status: "saved" })).toBe(true);
    // A viewer's (or withdrawn editor's) edits are never published.
    expect(roomExitLosesNothing({ canEdit: false, status: "pending" })).toBe(
      true,
    );
  });

  it("starts with nothing unsaved and is pending only after a change", () => {
    const state = createRoomSaveState({ currentElements: () => [] });
    expect(state.state().status).toBe("idle");
    // A reconnect before any change leaves nothing unsaved.
    state.reset();
    expect(state.state().status).toBe("idle");
    state.changed();
    expect(state.state().status).toBe("pending");
    // Edits made before a reconnect are still unsaved after it.
    state.reset();
    expect(state.state().status).toBe("pending");
  });

  it("a nonwriter shortcut coalesces at the elected writer and confirms all members", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const a = h.createClient("a", { snapshotStore: backend.createStore() });
    const b = h.createClient("b", { snapshotStore: backend.createStore() });
    a.session.connect();
    b.session.connect();
    await settle(h);
    b.edit(() => [collabRectangle({ id: "from-b" })]);
    b.session.requestSave();
    b.session.requestSave();
    await settle(h);
    b.timers.advance(1_000);
    await settle(h);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saveIntents).toEqual(["cadence"]);
    expect(a.session.getSaveState().status).toBe("saved");
    expect(b.session.getSaveState().status).toBe("saved");
    a.session.destroy();
    b.session.destroy();
  });

  it("a peer's invented receipt triggers an independent read and cannot mark edits saved", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const a = h.createClient("a", { snapshotStore: backend.createStore() });
    a.session.connect();
    await settle(h);
    a.edit(() => [collabRectangle({ id: "not-stored" })]);
    const raw = createRawSender(h.network);
    const base = raw.sceneMessage({ sequence: 1, elements: [] });
    raw.transport.sendSceneMessage({
      ...base,
      type: "snapshot-control",
      payload: {
        kind: "persisted",
        captureId: "invented",
        revision: 99,
        checksum: "0".repeat(64),
      },
    });
    h.settle();
    a.timers.advance(1_000);
    await settle(h);
    expect(a.session.getSaveState().status).toBe("pending");
    expect(backend.loadCount).toBeGreaterThan(1);
    a.session.destroy();
    raw.transport.close();
  });

  it("writer departure permits takeover and a conflict confirms the durable winner", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const a = h.createClient("a", { snapshotStore: backend.createStore() });
    const b = h.createClient("b", { snapshotStore: backend.createStore() });
    a.session.connect();
    b.session.connect();
    await settle(h);
    b.edit(() => [collabRectangle({ id: "takeover" })]);
    await settle(h);
    a.session.destroy();
    b.session.requestSave();
    await settle(h);
    expect(backend.elements.map((e) => e.id)).toEqual(["takeover"]);
    expect(b.session.getSaveState().status).toBe("saved");
    b.edit((elements) => elements.map((e) => editedElement(e, { x: 100 })));
    backend.publish(b.host.elements);
    b.timers.advance(30_000);
    await settle(h);
    // Conflict loads the independently stored winner and confirms its coverage.
    expect(b.session.getSaveState().status).toBe("saved");
    b.session.destroy();
  });

  it("a nonwriter recovers a lost persistence notice without uploading a snapshot", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const a = h.createClient("a", { snapshotStore: backend.createStore() });
    const b = h.createClient("b", { snapshotStore: backend.createStore() });
    a.session.connect();
    b.session.connect();
    await settle(h);
    b.edit(() => [collabRectangle({ id: "lost-notice" })]);
    await settle(h);
    a.session.requestSave();
    await drainAsync();
    expect(a.session.getSaveState().status).toBe("saved");
    h.network.setFaults({ dropProbability: 1 });
    h.network.flush();
    h.network.setFaults();
    expect(b.session.getSaveState().status).toBe("pending");
    b.timers.advance(30_000);
    await settle(h);
    expect(b.session.getSaveState().status).toBe("saved");
    expect(backend.saves).toHaveLength(1);
    a.session.destroy();
    b.session.destroy();
  });

  it("a delayed successful write only covers its captured edits", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const store = backend.createStore();
    let release: (() => void) | undefined;
    const a = h.createClient("a", {
      snapshotStore: {
        ...store,
        save: async (input) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return store.save(input);
        },
      },
    });
    a.session.connect();
    await settle(h);
    a.edit(() => [collabRectangle({ id: "edit" })]);
    a.session.requestSave();
    await settle(h);
    a.edit((elements) => elements.map((e) => editedElement(e, { x: 100 })));
    release?.();
    await settle(h);
    expect(backend.elements[0]?.x).toBe(0);
    expect(a.session.getSaveState().status).toBe("pending");
    a.session.destroy();
    await drainAsync();
    release?.();
    await drainAsync();
  });

  it("an unchanged loaded snapshot is confirmed after its attachments become available", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    backend.publish([collabImage({ id: "image", fileId: "image-file" })]);
    let available = false;
    const a = h.createClient("a", {
      snapshotStore: backend.createStore(),
      assetStore: {
        publish: async () => undefined,
        request: async () => undefined,
        destroy: () => undefined,
        areAvailable: async () => available,
      },
    });
    a.session.connect();
    await settle(h);
    expect(a.session.getSaveState().status).toBe("failed");
    available = true;
    a.session.requestSave();
    await settle(h);
    expect(a.session.getSaveState()).toMatchObject({
      status: "saved",
      revision: 1,
    });
    expect(backend.saves).toHaveLength(0);
    a.session.destroy();
  });

  it("missing durable attachments refuse saved state; viewers cannot request writes", async () => {
    const h = createHarness();
    const backend = createSnapshotBackend();
    const a = h.createClient("a", { snapshotStore: backend.createStore() });
    a.session.connect();
    await settle(h);
    a.edit(() => [collabImage({ id: "image", fileId: "missing" })]);
    a.session.requestSave();
    await settle(h);
    expect(backend.saves).toHaveLength(0);
    expect(a.session.getSaveState().status).toBe("failed");
    const viewer = h.createClient("viewer", {
      role: "viewer",
      snapshotStore: backend.createStore(),
    });
    viewer.session.connect();
    await settle(h);
    viewer.session.requestSave();
    await settle(h);
    expect(backend.saves).toHaveLength(0);
    a.session.destroy();
    viewer.session.destroy();
  });
});
