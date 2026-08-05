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
      "./asset",
      "./join-barrier",
      "./offline-queue",
      "./protocol",
      "./realtime-crypto",
      "./recovery",
      "./relay-client",
      "./relay-protocol",
      "./room-auth",
      "./room-token",
      "./snapshot",
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
          violations.push(
            `${path.relative(packageRoot, filePath)} -> ${specifier}`,
          );
        }
      }
    }
    // `room-token.ts` is the single server-only module and the only place
    // allowed to reach a runtime builtin: HMAC signing must stay out of every
    // browser-reachable entry point.
    expect(violations).toEqual(["src/room-token.ts -> node:crypto"]);
  });

  it("resolves every public entry point to its source module", () => {
    const expectedEntries = {
      "@drawstuff/collaboration/asset": "asset.ts",
      "@drawstuff/collaboration/join-barrier": "join-barrier.ts",
      "@drawstuff/collaboration/offline-queue": "offline-queue.ts",
      "@drawstuff/collaboration/protocol": "protocol.ts",
      "@drawstuff/collaboration/realtime-crypto": "realtime-crypto.ts",
      "@drawstuff/collaboration/recovery": "recovery.ts",
      "@drawstuff/collaboration/relay-client": "relay-client.ts",
      "@drawstuff/collaboration/relay-protocol": "relay-protocol.ts",
      "@drawstuff/collaboration/room-auth": "room-auth.ts",
      "@drawstuff/collaboration/room-token": "room-token.ts",
      "@drawstuff/collaboration/snapshot": "snapshot.ts",
      "@drawstuff/collaboration/testing": "testing.ts",
      "@drawstuff/collaboration/transport": "transport.ts",
    };

    for (const [specifier, fileName] of Object.entries(expectedEntries)) {
      expect(selfRequire.resolve(specifier)).toBe(
        path.join(sourceRoot, fileName),
      );
    }
  });

  it("has no logging surface at all", () => {
    // Plan 14 step 3: reviewing every logging path is only durable if there are
    // none. A single `console.log` in the send/receive path would be enough to
    // put plaintext elements, usernames, or cursors into a browser console or a
    // captured error report, so the whole package is kept output-free and
    // callers decide what (if anything) to report.
    const offenders = listSourceFiles(sourceRoot).filter((filePath) =>
      /\bconsole\s*\.|process\.(?:stdout|stderr)/.test(
        readFileSync(filePath, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("confines room key material to the crypto modules", () => {
    // The wire protocol, the relay client, and the token modules must never see
    // a room key: that is what lets the relay verify tokens it cannot turn into
    // a decryption key. Structural, so a future edit cannot quietly thread key
    // material through an envelope, a control frame, or a token claim.
    //
    // Three modules qualify, and only because they *are* the crypto boundary:
    // `realtime-crypto.ts` owns key derivation and realtime frames, and
    // `snapshot.ts` and `asset.ts` seal durable snapshots and binary assets
    // under second and third purpose-bound keys they derive through it.
    const withKeyMaterial = listSourceFiles(sourceRoot)
      .filter((filePath) =>
        /roomKey|RoomKey|getRandomValues|subtle/.test(
          readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(sourceRoot, filePath))
      .sort();
    expect(withKeyMaterial).toEqual([
      "asset.ts",
      "realtime-crypto.ts",
      "snapshot.ts",
    ]);
  });

  it("rejects package deep imports", () => {
    expect(() =>
      selfRequire.resolve("@drawstuff/collaboration/src/messages.ts"),
    ).toThrow(/exports|subpath/i);
  });
});
