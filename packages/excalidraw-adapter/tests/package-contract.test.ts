import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
      "./client",
      "./codec",
      "./reconcile",
      "./types",
    ]);
    expect(packageJson.sideEffects).toEqual(["./src/client.ts", "**/*.css"]);
  });

  it("keeps the upstream stylesheet on the client side-effect boundary", () => {
    expect(
      readFileSync(path.join(packageRoot, "src/client.ts"), "utf8"),
    ).toContain('import "@excalidraw/excalidraw/index.css";');
  });

  it("resolves from apps/web without a verification-only app import", () => {
    const expectedEntries = {
      "@drawstuff/excalidraw-adapter/client": "client.ts",
      "@drawstuff/excalidraw-adapter/codec": "codec.ts",
      "@drawstuff/excalidraw-adapter/reconcile": "reconcile.ts",
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
    const [codecEntry, typesEntry] = await Promise.all([
      import("@drawstuff/excalidraw-adapter/codec"),
      import("@drawstuff/excalidraw-adapter/types"),
    ]);

    expect(Object.keys(codecEntry).sort()).toEqual(
      [
        "DRAWSTUFF_DOCUMENT_VERSION",
        "EXCALIDRAW_PERSISTENCE_CONTRACT",
        "OFFICIAL_SERVER_APP_STATE_KEYS",
        "clearElementsForOfficialExport",
        "createDrawstuffDocumentV4",
        "createLocalExportDocument",
        "createOwnedSceneDocumentV4",
        "createReadonlyShareDocumentV4",
        "ensureInitialAppState",
        "filterReferencedFiles",
        "parseDrawstuffDocument",
        "selectOfficialServerAppState",
        "serializeDrawstuffDocumentV4",
        "toNativeExcalidrawScene",
      ].sort(),
    );
    expect(Object.keys(typesEntry)).toEqual([]);
  });
});
