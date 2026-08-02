import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json";

const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "src");
const selfRequire = createRequire(path.join(packageRoot, "package.json"));

const listSourceFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));

describe("@drawstuff/collaboration package contract", () => {
  it("exposes only the approved public entry points", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      "./protocol",
      "./testing",
      "./transport",
    ]);
    expect(packageJson.sideEffects).toBe(false);
  });

  it("keeps the domain core free of frameworks, transports, and databases", () => {
    expect(Object.keys(packageJson.dependencies)).toEqual(["zod"]);

    const importPattern = /(?:from|import)\s+["']([^"']+)["']/g;
    const violations: string[] = [];
    for (const filePath of listSourceFiles(sourceRoot)) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        if (specifier !== "zod" && !specifier.startsWith("./")) {
          violations.push(`${path.relative(packageRoot, filePath)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves every public entry point to its source module", () => {
    const expectedEntries = {
      "@drawstuff/collaboration/protocol": "protocol.ts",
      "@drawstuff/collaboration/testing": "testing.ts",
      "@drawstuff/collaboration/transport": "transport.ts",
    };

    for (const [specifier, fileName] of Object.entries(expectedEntries)) {
      expect(selfRequire.resolve(specifier)).toBe(
        path.join(sourceRoot, fileName),
      );
    }
  });

  it("rejects package deep imports", () => {
    expect(() =>
      selfRequire.resolve("@drawstuff/collaboration/src/messages.ts"),
    ).toThrow(/exports|subpath/i);
  });
});
