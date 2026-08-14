import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Test-only entry point, mirroring `@drawstuff/collaboration/testing`: the
 * supported way for downstream test suites to reach this package's upstream
 * fixtures. `apps/web` used to reach them with `../../../packages/…` relative
 * paths, which bypassed the package boundary and broke silently whenever the
 * fixture tree moved.
 *
 * Node-only (it reads from disk); never import it from runtime code.
 */

const fixturesRoot = path.resolve(import.meta.dirname, "../tests/fixtures");

/**
 * Absolute path of one fixture file, e.g.
 * `adapterFixturePath("excalidraw-0.18.1", "contract-input.json")`.
 */
export function adapterFixturePath(...segments: string[]): string {
  return path.join(fixturesRoot, ...segments);
}

/** Reads and parses one JSON fixture. */
export function readAdapterFixture<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(adapterFixturePath(...segments), "utf8")) as T;
}
