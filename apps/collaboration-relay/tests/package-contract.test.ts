import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json";

const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "src");

const listSourceFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));

/**
 * Plan 00/12 boundary: the relay routes protocol frames and nothing else. It
 * must not depend on the canvas engine, React, the web app, or any
 * persistence layer — a relay restart cannot touch PostgreSQL or owned-scene
 * payloads because no code path can reach them.
 */
const ALLOWED_IMPORT = new RegExp(
  "^(?:node:|ws$|\\./|@drawstuff/collaboration/(?:protocol|relay-protocol)$)",
);

describe("@drawstuff/collaboration-relay package contract", () => {
  it("depends only on the collaboration protocol and ws", () => {
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      "@drawstuff/collaboration",
      "ws",
    ]);
  });

  it("keeps relay sources free of engine, app, and persistence imports", () => {
    const importPattern = /(?:from|import)\s+["']([^"']+)["']/g;
    const violations: string[] = [];
    for (const filePath of listSourceFiles(sourceRoot)) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        if (!ALLOWED_IMPORT.test(specifier)) {
          violations.push(
            `${path.relative(packageRoot, filePath)} -> ${specifier}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
