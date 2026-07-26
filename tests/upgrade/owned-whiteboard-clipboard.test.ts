import { describe, expect, it } from "vitest";
import type {
  WhiteboardAsset,
  WhiteboardDocument,
  WhiteboardElement,
} from "@/features/whiteboard";
import {
  createOwnedClipboardPayload,
  isOwnedClipboardPayloadSizeAllowed,
  OwnedWhiteboardStore,
  parseOwnedClipboardPayload,
  remapOwnedClipboardPayload,
  serializeOwnedClipboardPayload,
} from "@/features/whiteboard/owned";

describe("owned whiteboard clipboard", () => {
  it("round-trips the versioned payload and rejects malformed or unsupported data", () => {
    const payload = createOwnedClipboardPayload([image("image", "asset")], {
      asset,
    });

    expect(
      parseOwnedClipboardPayload(serializeOwnedClipboardPayload(payload)),
    ).toEqual(payload);
    expect(parseOwnedClipboardPayload("not json")).toBeNull();
    expect(
      parseOwnedClipboardPayload(JSON.stringify({ ...payload, version: 2 })),
    ).toBeNull();
    expect(
      parseOwnedClipboardPayload(
        JSON.stringify({
          version: 1,
          elements: [{ id: "broken" }],
          assets: {},
        }),
      ),
    ).toBeNull();
  });

  it("remaps every element and asset ID, including colliding generators", () => {
    const payload = createOwnedClipboardPayload([image("image", "asset")], {
      asset,
    });
    const ids = ["taken", "fresh-asset", "fresh-element"];
    const remapped = remapOwnedClipboardPayload(
      payload,
      new Set(["image", "taken"]),
      new Set(["asset", "taken"]),
      () => ids.shift() ?? "fallback",
      20,
    );

    expect(remapped.assets[0]?.id).toBe("fresh-asset");
    expect(remapped.elements[0]).toMatchObject({
      id: "fresh-element",
      fileId: "fresh-asset",
      x: 20,
      y: 20,
    });
  });

  it("remaps internal group, container, frame, and binding references", () => {
    const first = {
      ...image("first", "asset"),
      groupIds: ["group"],
      boundElements: [{ id: "second", type: "rectangle" }],
      frameId: "second",
      endBinding: { elementId: "second", focus: 0, gap: 1 },
    } as unknown as WhiteboardElement;
    const second = {
      ...image("second", "asset"),
      groupIds: ["group"],
      containerId: "first",
      boundElementIds: ["first"],
      startBinding: { elementId: "first", focus: 0, gap: 1 },
    } as unknown as WhiteboardElement;
    let id = 0;

    const remapped = remapOwnedClipboardPayload(
      createOwnedClipboardPayload([first, second], { asset }),
      new Set(["first", "second"]),
      new Set(["asset"]),
      () => `new-${++id}`,
      20,
    );
    const serialized = JSON.stringify(remapped.elements);

    expect(serialized).not.toContain('"group"');
    expect(serialized).not.toContain('"elementId":"first"');
    expect(serialized).not.toContain('"elementId":"second"');
    expect(serialized).not.toContain('"containerId":"first"');
    expect(serialized).not.toContain('"frameId":"second"');
    expect(remapped.elements[0]).toMatchObject({
      frameId: remapped.elements[1]?.id,
      endBinding: { elementId: remapped.elements[1]?.id },
    });
    expect(remapped.elements[1]).toMatchObject({
      containerId: remapped.elements[0]?.id,
      startBinding: { elementId: remapped.elements[0]?.id },
    });
  });

  it("measures the clipboard limit in UTF-8 bytes", () => {
    expect(isOwnedClipboardPayloadSizeAllowed("a".repeat(4_999_999))).toBe(
      true,
    );
    expect(isOwnedClipboardPayloadSizeAllowed("界".repeat(1_700_000))).toBe(
      false,
    );
  });

  it("offsets repeated pastes and keeps all IDs unique across undoable commands", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([image("image", "asset")], { asset }));
    store.setSelection(["image"]);
    const payload = store.createClipboardPayload()!;
    let id = 0;
    const createId = () => `new-${++id}`;

    store.pasteClipboardPayload(payload, createId, 20);
    store.pasteClipboardPayload(payload, createId, 40);

    const pasted = store.getDocument().elements.slice(1);
    expect(pasted.map((element) => [element.x, element.y])).toEqual([
      [20, 20],
      [40, 40],
    ]);
    expect(
      new Set(store.getDocument().elements.map((element) => element.id)),
    ).toHaveProperty("size", 3);
    expect(new Set(Object.keys(store.getAssets()))).toHaveProperty("size", 3);
    expect(store.getHistoryDiagnostics().undoKinds).toEqual(["paste", "paste"]);
    store.undo();
    expect(store.getDocument().elements).toHaveLength(2);
  });

  it("pastes locked elements without placing them in the editable selection", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(document([]));
    const payload = createOwnedClipboardPayload(
      [
        {
          ...image("locked-image", "asset"),
          locked: true,
        },
      ],
      { asset },
    );

    store.pasteClipboardPayload(payload, () => "remapped", 20);

    expect(store.getDocument().elements).toHaveLength(1);
    expect(store.getEditorState().selectedElementIds).toEqual([]);
  });
});

const asset: WhiteboardAsset = {
  id: "asset",
  dataURL: "data:image/png;base64,AA==",
  mimeType: "image/png",
  created: 1,
};

function image(id: string, fileId: string): WhiteboardElement {
  return {
    id,
    type: "image",
    isDeleted: false,
    fileId,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
  };
}

function document(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>> = {},
): WhiteboardDocument {
  return {
    elements,
    assets,
    state: {
      name: "",
      theme: "light",
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
  };
}
