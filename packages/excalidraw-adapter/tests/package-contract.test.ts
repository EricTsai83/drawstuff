import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json";

const packageRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const webRequire = createRequire(
  path.join(workspaceRoot, "apps/web/package.json"),
);

describe("@drawstuff/excalidraw-adapter package contract", () => {
  it("exposes only the approved public entry points", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./client",
      "./codec",
      "./types",
    ]);
    expect(packageJson.sideEffects).toEqual(["**/*.css"]);
  });

  it("resolves from apps/web without a verification-only app import", () => {
    const expectedEntries = {
      "@drawstuff/excalidraw-adapter": "index.ts",
      "@drawstuff/excalidraw-adapter/client": "client.ts",
      "@drawstuff/excalidraw-adapter/codec": "codec.ts",
      "@drawstuff/excalidraw-adapter/types": "types.ts",
    };

    for (const [specifier, fileName] of Object.entries(expectedEntries)) {
      expect(webRequire.resolve(specifier)).toBe(
        path.join(packageRoot, "src", fileName),
      );
    }
  });

  it("rejects package deep imports", () => {
    expect(() =>
      webRequire.resolve("@drawstuff/excalidraw-adapter/src/index.ts"),
    ).toThrow(/exports|subpath/i);
  });

  it("owns the lockfile-pinned upstream dependency", () => {
    expect(packageJson.dependencies["@excalidraw/excalidraw"]).toBe("^0.18.1");
  });

  it("loads server-safe entries without a browser environment", async () => {
    const [rootEntry, codecEntry, typesEntry] = await Promise.all([
      import("@drawstuff/excalidraw-adapter"),
      import("@drawstuff/excalidraw-adapter/codec"),
      import("@drawstuff/excalidraw-adapter/types"),
    ]);

    expect(Object.keys(rootEntry)).toEqual([]);
    expect(Object.keys(codecEntry)).toEqual([]);
    expect(Object.keys(typesEntry)).toEqual([]);
  });
});
