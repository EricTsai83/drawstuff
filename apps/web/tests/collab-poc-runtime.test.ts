import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  OrderedExcalidrawElement,
  SceneData,
  SocketId,
} from "@drawstuff/excalidraw-adapter/types";

import type { BroadcastChannelLike } from "@/lib/collab/broadcast-channel-transport";
import { startCollabPoc } from "@/lib/collab/poc";

function createChannelStub() {
  const created: Array<{ name: string; closed: boolean }> = [];
  const createChannel = (name: string): BroadcastChannelLike => {
    const record = { name, closed: false };
    created.push(record);
    return {
      onmessage: null,
      postMessage: () => undefined,
      close: () => {
        record.closed = true;
      },
    };
  };
  return { created, createChannel };
}

function createExcalidrawApiStub(): ExcalidrawImperativeAPI {
  let elements: readonly OrderedExcalidrawElement[] = [];
  const appState = {
    editingTextElement: null,
    newElement: null,
    resizingElement: null,
    collaborators: new Map<SocketId, Collaborator>(),
    selectedElementIds: {},
  };
  const stub = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    updateScene: (sceneData: SceneData) => {
      if (sceneData.elements) {
        elements = sceneData.elements as readonly OrderedExcalidrawElement[];
      }
      if (sceneData.collaborators) {
        appState.collaborators = sceneData.collaborators;
      }
    },
  };
  return stub as unknown as ExcalidrawImperativeAPI;
}

describe("collab POC runtime lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects invalid room ids without starting anything", () => {
    const { created, createChannel } = createChannelStub();
    const handle = startCollabPoc({
      excalidrawApi: createExcalidrawApiStub(),
      roomIdRaw: "bad room id!",
      usernameRaw: "alice",
      wrapRemoteApply: (apply) => apply(),
      transportOptions: { createChannel },
    });
    expect(handle).toBeUndefined();
    expect(created).toHaveLength(0);
    expect(window.__drawstuffCollabPoc).toBeUndefined();
  });

  it("cleans up the channel, listeners, timers and test hook on destroy", () => {
    const { created, createChannel } = createChannelStub();
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");

    const handle = startCollabPoc({
      excalidrawApi: createExcalidrawApiStub(),
      roomIdRaw: "room-poc-runtime",
      usernameRaw: "  alice  ",
      wrapRemoteApply: (apply) => apply(),
      transportOptions: { createChannel },
    });
    expect(handle).toBeDefined();
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe("drawstuff-collab-poc:room-poc-runtime");
    expect(window.__drawstuffCollabPoc?.getSceneSnapshot()).toBe("[]");
    expect(
      addListener.mock.calls.filter(([type]) => type === "visibilitychange"),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // armed idle timer

    handle?.destroy();

    expect(created[0]?.closed).toBe(true);
    expect(
      removeListener.mock.calls.filter(([type]) => type === "visibilitychange"),
    ).toHaveLength(1);
    expect(window.__drawstuffCollabPoc).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
