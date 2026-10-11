// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    COLLAB_CONTROL_URL: "https://do.invalid",
    COLLAB_ROOMS_DISABLED: undefined,
  },
}));

import { isSwitchOn } from "@/server/collab/relay-routing";

describe("DO-only relay routing", () => {
  it("treats explicit off-words as off and any other set value as on", () => {
    expect(isSwitchOn(undefined)).toBe(false);
    expect(isSwitchOn("0")).toBe(false);
    expect(isSwitchOn("false")).toBe(false);
    expect(isSwitchOn("OFF")).toBe(false);
    expect(isSwitchOn("1")).toBe(true);
    expect(isSwitchOn("yse")).toBe(true);
  });
});
