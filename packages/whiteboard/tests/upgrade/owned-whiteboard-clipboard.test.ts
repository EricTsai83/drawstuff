import { describe, expect, it } from "vitest";
import type {
  WhiteboardAsset,
  OwnedWhiteboardDocument,
  WhiteboardElement,
} from "@drawstuff/whiteboard";
import {
  createOwnedClipboardPayload,
  isOwnedClipboardPayloadSizeAllowed,
  OwnedWhiteboardStore,
  parseOwnedClipboardPayload,
  remapOwnedClipboardPayload,
  serializeOwnedClipboardPayload,
} from "@drawstuff/whiteboard";
import { createTestElementV3 } from "../helpers";

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

  it("copies and duplicates a container together with its bound text", () => {
    const store = new OwnedWhiteboardStore();
    store.loadDocument(
      document([
        createTestElementV3({ id: "container", type: "rectangle" }),
        createTestElementV3({
          id: "label",
          type: "text",
          text: "Bound label",
          originalText: "Bound label",
          containerId: "container",
        }),
      ]),
    );
    store.setSelection(["container"]);

    const payload = store.createClipboardPayload();
    expect(payload?.elements.map(({ id }) => id)).toEqual([
      "container",
      "label",
    ]);

    let nextId = 0;
    store.duplicateSelection(() => `duplicate-${++nextId}`, 20);
    const duplicate = store
      .getDocument()
      .elements.find((element) => element.id === "duplicate-1");
    const duplicateText = store
      .getDocument()
      .elements.find((element) => element.id === "duplicate-2");
    expect(duplicate).toMatchObject({ type: "rectangle", x: 20 });
    expect(duplicateText).toMatchObject({
      type: "text",
      text: "Bound label",
      containerId: "duplicate-1",
      x: 20,
    });
  });

  it("preserves available external bindings and clears unavailable targets", () => {
    const arrow = createTestElementV3({
      id: "arrow",
      type: "arrow",
      startBinding: {
        elementId: "external-target",
        focus: 0,
        gap: 0,
      },
    });
    const payload = {
      version: 1,
      elements: [arrow],
      assets: {},
    } as const;

    const sameDocument = remapOwnedClipboardPayload(
      payload,
      new Set(["external-target"]),
      new Set(),
      () => "arrow-copy",
      0,
    );
    expect(sameDocument.elements[0]).toMatchObject({
      startBinding: { elementId: "external-target" },
    });

    const otherDocument = remapOwnedClipboardPayload(
      payload,
      new Set(),
      new Set(),
      () => "arrow-copy",
      0,
    );
    expect(otherDocument.elements[0]).toMatchObject({ startBinding: null });
  });
});

const asset: WhiteboardAsset = {
  id: "asset",
  dataURL: "data:image/png;base64,AA==",
  mimeType: "image/png",
  created: 1,
};

function image(id: string, fileId: string): WhiteboardElement {
  return createTestElementV3({
    id,
    type: "image",
    isDeleted: false,
    fileId,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    locked: false,
  });
}

function document(
  elements: readonly WhiteboardElement[],
  assets: Readonly<Record<string, WhiteboardAsset>> = {},
): OwnedWhiteboardDocument {
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
