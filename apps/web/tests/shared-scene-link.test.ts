import { describe, expect, it } from "vitest";
import {
  buildSharedSceneUrl,
  parseSharedSceneHash,
} from "@/lib/shared-scene-link";

describe("shared scene link", () => {
  it("round-trips the id and key through the URL fragment", () => {
    const url = buildSharedSceneUrl("https://draw.example", {
      id: "Dp_UO-mth",
      key: "k3y_-",
    });
    expect(url).toBe("https://draw.example/#json=Dp_UO-mth,k3y_-");
    expect(parseSharedSceneHash(new URL(url).hash)).toEqual({
      id: "Dp_UO-mth",
      key: "k3y_-",
    });
  });

  it("rejects fragments that are not exactly one id and one key", () => {
    for (const hash of ["", "#json=", "#json=id", "#json=id,key,x", "#x=a,b"]) {
      expect(parseSharedSceneHash(hash)).toBeNull();
    }
  });
});
