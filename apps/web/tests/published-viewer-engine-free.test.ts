import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `/p/[slug]` must not ship Excalidraw to visitors: the artifact path of the
 * viewer downloads a pre-rendered SVG and never needs the engine. The engine
 * enters `apps/web` only through the adapter's `client` entry (and the
 * upstream package itself, which the adapter alone may import), so walking the
 * artifact path's static import graph and asserting neither specifier appears
 * proves the visitor bundle stays engine-free — without a `next build`, which
 * would share `.next` with a running dev server.
 */
const ENGINE_SPECIFIERS = [
  "@drawstuff/excalidraw-adapter/client",
  "@excalidraw/excalidraw",
];

const srcRoot = path.resolve(import.meta.dirname, "../src");
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

// Value imports only: `import type` is erased and pulls nothing into a bundle.
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\s)[^;'"]*?\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(specifier: string, from: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? path.join(srcRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  for (const candidate of [base, ...EXTENSIONS.map((ext) => base + ext)]) {
    try {
      if (readFileSync(candidate, "utf8")) return candidate;
    } catch {
      // try the next extension
    }
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

/** Static (non-dynamic) value imports reachable from `entry`, and every bare specifier seen. */
function collectImportGraph(entry: string) {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8").replace(DYNAMIC_IMPORT_RE, "");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const local = resolveLocal(specifier, file);
      if (local) queue.push(local);
      else external.add(specifier);
    }
  }
  return { files, external };
}

const viewerPath = (name: string) =>
  path.join(srcRoot, "components/excalidraw", name);

describe("published viewer artifact path", () => {
  it("reaches neither the adapter's client entry nor the engine", () => {
    const wrapper = collectImportGraph(
      viewerPath("published-scene-viewer-wrapper.tsx"),
    );
    for (const specifier of ENGINE_SPECIFIERS) {
      expect([...wrapper.external]).not.toContain(specifier);
    }
    // `/p/*` has its own, tighter CSP; a next/link soft navigation out of the
    // viewer would keep that policy alive inside the workspace. Every link
    // leaving the viewer must be a full-document navigation.
    expect([...wrapper.external]).not.toContain("next/link");
    // Sanity: the graph is real, not an empty walk.
    expect([...wrapper.files]).toContain(
      viewerPath("published-scene-viewer.tsx"),
    );
    expect([...wrapper.files]).toContain(
      path.join(srcRoot, "hooks/excalidraw/use-svg-pan-zoom.ts"),
    );
  });

  it("leaves the /p CSP boundary with full-document navigation from every page a /p document can show", () => {
    // A missing or unpublished slug renders the shared not-found page and a
    // render failure the shared error page — both inside the /p document.
    for (const entry of [
      path.join(srcRoot, "app/not-found.tsx"),
      path.join(srcRoot, "app/error.tsx"),
      path.join(srcRoot, "app/global-error.tsx"),
      path.join(srcRoot, "app/p/[slug]/layout.tsx"),
    ]) {
      const graph = collectImportGraph(entry);
      expect([...graph.external], entry).not.toContain("next/link");
      for (const specifier of ENGINE_SPECIFIERS) {
        expect([...graph.external], entry).not.toContain(specifier);
      }
    }
  });
});
