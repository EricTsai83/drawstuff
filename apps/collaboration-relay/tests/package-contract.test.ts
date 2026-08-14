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
  "^(?:node:|ws$|\\./|@drawstuff/collaboration/" +
    "(?:protocol|relay-control|relay-protocol|room-auth|room-token)$)",
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

  it("keeps every frame-handling source free of direct output", () => {
    // Plan 14 step 3: the relay handles ciphertext, but a log line is still a
    // copy. Plan 24 adds structured logs and keeps that property by making
    // `logger.ts` the single sink: it is the only file that may write, its field
    // type is a closed allowlist derived from the threat model's data
    // classification, and every other module — including every one that has a
    // frame in scope — can only reach output through it. A `process.stdout.write`
    // appearing anywhere else is a log line that bypassed the allowlist.
    const offenders = listSourceFiles(sourceRoot)
      .filter((filePath) =>
        /\bconsole\s*\.|process\.(?:stdout|stderr)/.test(
          readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(sourceRoot, filePath));
    expect(offenders).toEqual(["logger.ts"]);
  });

  it("never derives or holds a room encryption key", () => {
    // The relay is an authorization boundary, not a key distribution channel.
    const offenders = listSourceFiles(sourceRoot)
      .filter((filePath) =>
        /roomKey|RoomKey|realtime-crypto|subtle/.test(
          readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(sourceRoot, filePath));
    expect(offenders).toEqual([]);
  });
});
