import { describe, expect, it } from "vitest";

import {
  RELAY_CONTROL_PATH,
  relayControlRequestSchema,
  relayControlResponseSchema,
} from "../src/relay-control.ts";

/**
 * The control channel used to be two parallel hand-written copies (the app's
 * fetch caller and the relay's HTTP handler). Both now import this one module,
 * so pinning the contract here pins it for both sides at once.
 */
describe("relay control contract", () => {
  it("pins the control path", () => {
    expect(RELAY_CONTROL_PATH).toBe("/control/room");
  });

  it("accepts a request that carries one non-empty token", () => {
    const parsed = relayControlRequestSchema.safeParse({ token: "abc" });
    expect(parsed.success).toBe(true);
  });

  it("strips unknown request keys instead of refusing them", () => {
    const parsed = relayControlRequestSchema.safeParse({
      token: "abc",
      extra: "ignored",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ token: "abc" });
  });

  it("refuses an empty or missing token", () => {
    expect(relayControlRequestSchema.safeParse({ token: "" }).success).toBe(
      false,
    );
    expect(relayControlRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts both control actions in the response", () => {
    for (const action of ["end-room", "revoke-member"]) {
      const parsed = relayControlResponseSchema.safeParse({
        action,
        closed: 0,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("refuses a response without a usable closed count", () => {
    expect(
      relayControlResponseSchema.safeParse({ action: "end-room" }).success,
    ).toBe(false);
    expect(
      relayControlResponseSchema.safeParse({ action: "end-room", closed: -1 })
        .success,
    ).toBe(false);
    expect(
      relayControlResponseSchema.safeParse({ action: "shrug", closed: 1 })
        .success,
    ).toBe(false);
  });
});
