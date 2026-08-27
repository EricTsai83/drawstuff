import { describe, expect, it } from "vitest";

import {
  createDoLogger,
  DO_LOG_ENVELOPE_FIELDS,
  DO_LOGGABLE_FIELD_NAMES,
  errorNameOf,
} from "../src/logger.ts";

type CapturedRecord = { level: string; record: Record<string, unknown> };

function createCapture(): {
  records: CapturedRecord[];
  sink: (level: string, record: Record<string, unknown>) => void;
} {
  const records: CapturedRecord[] = [];
  return {
    records,
    sink: (level, record) => records.push({ level, record }),
  };
}

describe("DO structured logger", () => {
  it("emits the envelope, the version metadata and allowlisted fields", () => {
    const capture = createCapture();
    const log = createDoLogger({ id: "v-123", tag: "canary" }, capture.sink);
    log.info("room.session_joined", {
      roomId: "room-a",
      authGeneration: 1,
      peerId: "peer-1",
      role: "editor",
      members: 2,
    });
    expect(capture.records).toHaveLength(1);
    const { level, record } = capture.records[0]!;
    expect(level).toBe("info");
    expect(record).toEqual({
      event: "room.session_joined",
      versionId: "v-123",
      versionTag: "canary",
      roomId: "room-a",
      authGeneration: 1,
      peerId: "peer-1",
      role: "editor",
      members: 2,
    });
  });

  it("drops fields outside the allowlist and counts the rejection", () => {
    const capture = createCapture();
    const log = createDoLogger({ id: "v-123" }, capture.sink);
    // A structurally-compatible variable can smuggle extra properties past
    // the compiler; the runtime allowlist is the layer that must catch it.
    const smuggled = {
      roomId: "room-a",
      token: "secret-token-material",
      message: "free-form text",
    };
    log.warn("gateway.control_token_rejected", smuggled);
    const { record } = capture.records[0]!;
    expect(record.roomId).toBe("room-a");
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("message");
    expect(record.rejectedFields).toBe(2);
  });

  it("omits undefined fields, empty version tags and absent versions", () => {
    const capture = createCapture();
    const log = createDoLogger({ id: "v-123", tag: "" }, capture.sink);
    log.error("room.secret_not_ready", { peerId: undefined });
    const { record } = capture.records[0]!;
    expect(record).toEqual({
      event: "room.secret_not_ready",
      versionId: "v-123",
    });
    expect(Object.keys(record)).not.toContain("peerId");
    expect(Object.keys(record)).not.toContain("versionTag");
  });

  it("routes levels to the matching sink level", () => {
    const capture = createCapture();
    const log = createDoLogger(undefined, capture.sink);
    log.info("room.session_closed", { closeCode: 1000 });
    log.warn("room.socket_error");
    log.error("gateway.unhandled_failure");
    expect(capture.records.map((entry) => entry.level)).toEqual([
      "info",
      "warn",
      "error",
    ]);
  });

  it("reduces thrown values to content-free identifiers", () => {
    expect(errorNameOf(new TypeError("includes user input"))).toBe("TypeError");
    expect(errorNameOf("a thrown string with payload data")).toBe("string");
    expect(errorNameOf(undefined)).toBe("undefined");
  });

  it("classifies errors from a closed set, never from the value itself", () => {
    // Both `name` and `constructor` are writable, so neither may be read: an
    // SDK (or an attacker-influenced payload) that stamped a URL or a token
    // fragment onto either must not be able to reach a log line.
    const namedSmuggling = new Error("boom");
    namedSmuggling.name = "https://redis.example/?token=super-secret";
    expect(errorNameOf(namedSmuggling)).toBe("Error");

    const constructorSmuggling = new Error("boom");
    Object.defineProperty(constructorSmuggling, "constructor", {
      value: { name: "https://redis.example/?token=super-secret" },
    });
    expect(errorNameOf(constructorSmuggling)).toBe("Error");

    // Subclasses collapse to their nearest built-in kind — a bounded enum,
    // not an open-ended class name.
    class UpstreamFailure extends TypeError {}
    const subclassed = new UpstreamFailure("boom");
    subclassed.name = "leaked-token-material";
    expect(errorNameOf(subclassed)).toBe("TypeError");

    expect(errorNameOf(new RangeError("x"))).toBe("RangeError");
    expect(errorNameOf(Object.create(Error.prototype) as Error)).toBe("Error");
  });

  it("stays total when the thrown value fights back", () => {
    // Every caller is already inside an exception handler; a throwing getter
    // or hasInstance must not escape it and take down the frame path.
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "constructor", {
      get() {
        throw new Error("nope");
      },
    });
    expect(errorNameOf(hostile)).toBe("Error");

    const trap = {};
    Object.defineProperty(trap, Symbol.hasInstance, {
      get() {
        throw new Error("nope");
      },
    });
    expect(() => errorNameOf(trap)).not.toThrow();
  });

  it("pins the documented schema surface", () => {
    // The observability contract doc lists these names; drift fails here
    // before it can silently invalidate the documented log queries.
    expect(DO_LOG_ENVELOPE_FIELDS).toEqual([
      "event",
      "versionId",
      "versionTag",
    ]);
    expect([...DO_LOGGABLE_FIELD_NAMES].sort()).toEqual(
      [
        "authGeneration",
        "closeCode",
        "closedSessions",
        "controlAction",
        "errorName",
        "members",
        "peerId",
        "role",
        "roomId",
        "socketState",
        "status",
        "tokenFailure",
      ].sort(),
    );
  });
});
