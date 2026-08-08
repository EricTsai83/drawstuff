import { describe, expect, it } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeCollaborationMessage,
  encodeCollaborationMessage,
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_SCENE_MESSAGE_BYTES,
  roomIdSchema,
} from "../src/protocol.ts";
import {
  asMessage,
  element,
  presenceMessage,
  sceneMessage,
} from "./helpers.ts";

const encodeOrThrow = (
  message: Parameters<typeof encodeCollaborationMessage>[0],
) => {
  const encoded = encodeCollaborationMessage(message);
  if (!encoded.ok) {
    throw new Error(`Expected encodable message: ${encoded.error.code}`);
  }
  return encoded.bytes;
};

describe("collaboration protocol codec", () => {
  it("round-trips scene messages and preserves unknown engine-owned element fields", () => {
    const message = sceneMessage({
      sequence: 1,
      elements: [
        element({
          strokeColor: "#1e1e1e",
          points: [
            [0, 0],
            [10, 12.5],
          ],
          customFutureField: { nested: true },
        }),
        element({ id: "el-2", version: 7, isDeleted: true }),
      ],
    });

    const decoded = decodeCollaborationMessage(encodeOrThrow(message), "scene");

    expect(decoded).toEqual({ ok: true, message });
    if (decoded.ok && decoded.message.type === "scene-update") {
      expect(decoded.message.payload.elements.map((el) => el.id)).toEqual([
        "el-1",
        "el-2",
      ]);
    }
  });

  it("round-trips presence messages", () => {
    const message = presenceMessage({
      sequence: 3,
      payload: { pointer: { x: -4.25, y: 900, tool: "laser" }, button: "down" },
    });

    expect(
      decodeCollaborationMessage(encodeOrThrow(message), "presence"),
    ).toEqual({
      ok: true,
      message,
    });
  });

  it("rejects oversize raw bytes before JSON parsing", () => {
    // All zero bytes: JSON.parse would fail, so getting an oversize error
    // (not a malformed one) proves the byte limit runs first.
    const decoded = decodeCollaborationMessage(
      new Uint8Array(MAX_SCENE_MESSAGE_BYTES + 1),
      "scene",
    );

    expect(decoded).toEqual({
      ok: false,
      error: {
        code: "oversize-payload",
        byteLength: MAX_SCENE_MESSAGE_BYTES + 1,
        maxByteLength: MAX_SCENE_MESSAGE_BYTES,
      },
    });

    // The volatile channel applies its smaller cap equally early.
    expect(
      decodeCollaborationMessage(
        new Uint8Array(MAX_PRESENCE_MESSAGE_BYTES + 1),
        "presence",
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "oversize-payload",
        byteLength: MAX_PRESENCE_MESSAGE_BYTES + 1,
        maxByteLength: MAX_PRESENCE_MESSAGE_BYTES,
      },
    });
  });

  it("rejects oversize scene messages at encode time", () => {
    const message = sceneMessage({
      sequence: 1,
      elements: [element({ blob: "x".repeat(MAX_SCENE_MESSAGE_BYTES) })],
    });

    const encoded = encodeCollaborationMessage(message);

    expect(encoded.ok).toBe(false);
    if (!encoded.ok) {
      expect(encoded.error.code).toBe("oversize-payload");
    }
  });

  it("applies the smaller volatile byte budget to presence messages", () => {
    const message = presenceMessage({
      sequence: 1,
      payload: {
        selectedElementIds: Array.from({ length: 256 }, (_, index) =>
          `element-${index}`.padEnd(64, "x"),
        ),
      },
    });

    const encoded = encodeCollaborationMessage(message);
    expect(encoded).toMatchObject({
      ok: false,
      error: {
        code: "oversize-payload",
        maxByteLength: MAX_PRESENCE_MESSAGE_BYTES,
      },
    });

    // The same over-budget presence payload is also refused before parsing
    // on the volatile channel even though it is far below the scene byte cap.
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    expect(bytes.byteLength).toBeLessThan(MAX_SCENE_MESSAGE_BYTES);
    expect(decodeCollaborationMessage(bytes, "presence")).toMatchObject({
      ok: false,
      error: {
        code: "oversize-payload",
        maxByteLength: MAX_PRESENCE_MESSAGE_BYTES,
      },
    });
  });

  it("rejects messages that arrive on the wrong channel", () => {
    const sceneBytes = encodeOrThrow(sceneMessage({ sequence: 1 }));
    const presenceBytes = encodeOrThrow(presenceMessage({ sequence: 1 }));

    expect(decodeCollaborationMessage(sceneBytes, "presence")).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
    expect(decodeCollaborationMessage(presenceBytes, "scene")).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
  });

  it("returns an error for unserializable engine-owned element fields", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const unserializable of [{ big: 1n }, { loop: circular }]) {
      const encoded = encodeCollaborationMessage(
        sceneMessage({ sequence: 1, elements: [element(unserializable)] }),
      );
      expect(encoded).toMatchObject({
        ok: false,
        error: { code: "malformed-payload" },
      });
    }
  });

  it("rejects malformed JSON", () => {
    const decoded = decodeCollaborationMessage(
      new TextEncoder().encode("{not json"),
      "scene",
    );

    expect(decoded).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
  });

  it("rejects invalid UTF-8 instead of silently repairing it", () => {
    const bytes = encodeOrThrow(sceneMessage({ sequence: 1 }));
    const corrupted = new Uint8Array(bytes);
    // Overwrite a byte inside the JSON with an invalid UTF-8 sequence start.
    corrupted[corrupted.length - 5] = 0xff;

    expect(decodeCollaborationMessage(corrupted, "scene")).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
  });

  it("rejects unknown protocol versions before shape validation", () => {
    const future = {
      ...sceneMessage({ sequence: 1 }),
      protocolVersion: COLLABORATION_PROTOCOL_VERSION + 1,
    };

    const decoded = decodeCollaborationMessage(
      new TextEncoder().encode(JSON.stringify(future)),
      "scene",
    );

    expect(decoded).toEqual({
      ok: false,
      error: {
        code: "unknown-protocol-version",
        receivedVersion: COLLABORATION_PROTOCOL_VERSION + 1,
      },
    });
    expect(
      decodeCollaborationMessage(new TextEncoder().encode("{}"), "scene"),
    ).toEqual({
      ok: false,
      error: { code: "unknown-protocol-version", receivedVersion: undefined },
    });
  });

  it("rejects envelope or payload fields outside the contract", () => {
    const withExtraEnvelopeField = {
      ...sceneMessage({ sequence: 1 }),
      passthrough: "nope",
    };
    const withFiles = {
      ...sceneMessage({ sequence: 1 }),
      payload: { elements: [element()], files: {} },
    };

    for (const invalid of [withExtraEnvelopeField, withFiles]) {
      expect(encodeCollaborationMessage(asMessage(invalid))).toMatchObject({
        ok: false,
        error: { code: "malformed-payload" },
      });
    }
  });

  it("rejects elements that lack reconciliation identity fields", () => {
    const missingVersionNonce = {
      ...sceneMessage({ sequence: 1 }),
      payload: {
        elements: [{ id: "el-1", version: 1, isDeleted: false }],
      },
    };

    const encoded = encodeCollaborationMessage(asMessage(missingVersionNonce));

    expect(encoded).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
  });

  it("rejects elements that embed binary asset data", () => {
    const withBinary = {
      ...sceneMessage({ sequence: 1 }),
      payload: {
        elements: [
          element(),
          { ...element(), dataURL: "data:image/png;base64,AAAA" },
        ],
      },
    };

    const encoded = encodeCollaborationMessage(asMessage(withBinary));

    expect(encoded).toMatchObject({
      ok: false,
      error: { code: "malformed-payload" },
    });
    if (!encoded.ok && encoded.error.code === "malformed-payload") {
      expect(encoded.error.detail).toContain("dataURL");
    }
  });

  it("constrains identifier formats", () => {
    for (const invalid of ["", "has space", "emoji-✏️", "x".repeat(65)]) {
      expect(roomIdSchema.safeParse(invalid).success).toBe(false);
    }
    expect(roomIdSchema.safeParse("A-valid_room-42").success).toBe(true);
  });

  it("pins protocol version 2 as the only active writer", () => {
    expect(COLLABORATION_PROTOCOL_VERSION).toBe(2);
  });
});
