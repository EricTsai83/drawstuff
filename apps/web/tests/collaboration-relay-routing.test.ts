// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    COLLAB_RELAY_URL: "wss://do.invalid",
    COLLAB_ROOMS_DISABLED: undefined,
  },
}));

import { isSwitchOn, resolveRelayUrl } from "@/server/collab/relay-routing";

describe("DO-only relay routing", () => {
  it("returns the generation-scoped Durable Object socket URL", () => {
    expect(
      resolveRelayUrl({
        roomId: "room-do-000000000000",
        authGeneration: 3,
      }),
    ).toBe(
      "wss://do.invalid/v1/rooms/room-do-000000000000/generations/3/socket",
    );
  });

  it("treats explicit off-words as off and any other set value as on", () => {
    expect(isSwitchOn(undefined)).toBe(false);
    expect(isSwitchOn("0")).toBe(false);
    expect(isSwitchOn("false")).toBe(false);
    expect(isSwitchOn("OFF")).toBe(false);
    expect(isSwitchOn("1")).toBe(true);
    expect(isSwitchOn("yse")).toBe(true);
  });
});
