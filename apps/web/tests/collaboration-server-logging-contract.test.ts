import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Threat model T13: no client-supplied string may reach a durable server-side
 * record.
 *
 * The relay already enforces this for itself — `logger.ts` is its only output
 * sink, its field type is a closed allowlist, and caller-supplied values like
 * the token subject are pseudonymized there. The backend currently satisfies
 * the same rule, but only by accident: the collaboration server paths happen to
 * contain no logging at all.
 *
 * An accident is not an invariant. These paths take caller-supplied identifiers
 * — `roomId`, asset file ids — as given, and `ID_PATTERN` accepts a
 * 43-character room key verbatim, so the day someone adds a
 * `console.log({ input })` to one of these files — the most ordinary debugging
 * move there is — a pasted room key becomes loggable through a *valid* request.
 * This test is what turns "happens to be true" into "stays true", and it fails
 * on exactly that edit.
 *
 * Scope is deliberately the collaboration server paths rather than all of
 * `apps/web`: the rest of the app has legitimate logging, and a rule nobody can
 * keep is a rule that gets deleted.
 */

const webRoot = path.resolve(import.meta.dirname, "..");

/** Server paths that handle collaboration input signed or stored as given. */
const GUARDED_PATHS = [
  path.join("src", "server", "collab"),
  path.join("src", "server", "api", "routers", "collaboration-room.ts"),
  path.join("src", "server", "api", "routers", "collaboration-snapshot.ts"),
  path.join("src", "server", "api", "routers", "collaboration-asset.ts"),
];

const listFiles = (target: string): string[] => {
  const absolute = path.join(webRoot, target);
  if (absolute.endsWith(".ts")) return [absolute];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

describe("collaboration backend logging contract", () => {
  it("writes no output from any path that handles caller-supplied identifiers", () => {
    const offenders = GUARDED_PATHS.flatMap(listFiles)
      .filter((filePath) =>
        /\bconsole\s*\.|process\.(?:stdout|stderr)/.test(
          readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(webRoot, filePath));

    // If this fails, the fix is not to add the file to the list. Either drop the
    // log, or confine it to a closed event/field schema that admits no
    // caller-supplied content, the way `apps/collaboration-do/src/logger.ts`
    // does — see threat model T13.
    expect(offenders).toEqual([]);
  });

  it("covers every collaboration router, so a new one cannot slip the rule", () => {
    // The guarded list is written out by hand, which only stays honest if adding
    // a `collaboration-*` router without listing it is caught here.
    const routers = readdirSync(
      path.join(webRoot, "src", "server", "api", "routers"),
    ).filter(
      (name) => name.startsWith("collaboration-") && name.endsWith(".ts"),
    );
    const guarded = new Set(GUARDED_PATHS.map((entry) => path.basename(entry)));

    expect(routers.filter((name) => !guarded.has(name))).toEqual([]);
  });
});
