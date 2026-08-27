import { describe, expect, it } from "vitest";

import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlRequestSchema,
  doGatewayControlResponseSchema,
  doGatewaySocketPath,
} from "../src/relay-control.ts";

/**
 * The control channel used to be two parallel hand-written copies (the app's
 * fetch caller and the gateway's HTTP handler). Both now import this one
 * module, so pinning the contract here pins it for both sides at once.
 */
describe("durable object gateway control contract", () => {
  it("pins the control path", () => {
    expect(DO_GATEWAY_CONTROL_PATH).toBe("/v1/control");
  });

  it("pins the generation-scoped socket path", () => {
    expect(doGatewaySocketPath("room-a", 3)).toBe(
      "/v1/rooms/room-a/generations/3/socket",
    );
  });

  it("accepts a request that carries one non-empty token", () => {
    const parsed = doGatewayControlRequestSchema.safeParse({ token: "abc" });
    expect(parsed.success).toBe(true);
  });

  it("fails closed on unknown request keys", () => {
    const parsed = doGatewayControlRequestSchema.safeParse({
      token: "abc",
      extra: "refused",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an empty or missing token", () => {
    expect(doGatewayControlRequestSchema.safeParse({ token: "" }).success).toBe(
      false,
    );
    expect(doGatewayControlRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a response with an applied revision and closed count", () => {
    const parsed = doGatewayControlResponseSchema.safeParse({
      appliedRevision: 1,
      closed: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("tolerates additional response fields from a newer gateway", () => {
    const parsed = doGatewayControlResponseSchema.safeParse({
      appliedRevision: 2,
      closed: 1,
      future: "optional",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a non-positive, fractional, or missing applied revision", () => {
    for (const appliedRevision of [0, -1, 1.5]) {
      expect(
        doGatewayControlResponseSchema.safeParse({ appliedRevision, closed: 0 })
          .success,
      ).toBe(false);
    }
    expect(
      doGatewayControlResponseSchema.safeParse({ closed: 0 }).success,
    ).toBe(false);
  });

  it("refuses a response without a usable closed count", () => {
    expect(
      doGatewayControlResponseSchema.safeParse({ appliedRevision: 1 }).success,
    ).toBe(false);
    expect(
      doGatewayControlResponseSchema.safeParse({
        appliedRevision: 1,
        closed: -1,
      }).success,
    ).toBe(false);
  });
});
