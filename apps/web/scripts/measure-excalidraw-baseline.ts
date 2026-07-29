import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  createOwnedSceneDocumentV4,
  createReadonlyShareDocumentV4,
  parseDrawstuffDocument,
  serializeDrawstuffDocumentV4,
} from "../src/lib/excalidraw-document-v4";
import {
  countSemanticControllerNotifications,
  createControllerNotificationTrace,
  createLargeSceneElements,
  EXCALIDRAW_PERFORMANCE_BUDGETS,
  LARGE_SCENE_ELEMENT_COUNT,
} from "../tests/support/excalidraw-performance-fixtures";

const ITERATIONS = 30;
const WARMUP_ITERATIONS = 5;
const nextDirectory = path.resolve(import.meta.dirname, "../.next");
const webDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(webDirectory, "../..");

const elements = createLargeSceneElements();
const fixtureAppState = {
  gridSize: 20,
  gridStep: 5,
  gridModeEnabled: true,
  viewBackgroundColor: "#ffffff",
  name: "Plan 00 performance fixture",
};
const fixtureFiles = {};
const ownedPayload = serializeFixture("owned-scene");
const controllerTrace = createControllerNotificationTrace();

const measurements = {
  largeSceneLoad: measure(() => parseDrawstuffDocument(ownedPayload)),
  largeSceneOwnedSave: measure(() => serializeFixture("owned-scene")),
  largeSceneReadonlySave: measure(() => serializeFixture("readonly-share")),
  controllerNotificationTrace: measure(() =>
    countSemanticControllerNotifications(controllerTrace),
  ),
};
const memory = measureMemory();
const bundle = measureRouteBundle();

const checks = {
  largeSceneLoad:
    measurements.largeSceneLoad.p95Ms <=
    EXCALIDRAW_PERFORMANCE_BUDGETS.largeSceneLoadP95Ms,
  largeSceneOwnedSave:
    measurements.largeSceneOwnedSave.p95Ms <=
    EXCALIDRAW_PERFORMANCE_BUDGETS.largeSceneOwnedSaveP95Ms,
  largeSceneReadonlySave:
    measurements.largeSceneReadonlySave.p95Ms <=
    EXCALIDRAW_PERFORMANCE_BUDGETS.largeSceneReadonlySaveP95Ms,
  controllerNotificationTrace:
    measurements.controllerNotificationTrace.p95Ms <=
      EXCALIDRAW_PERFORMANCE_BUDGETS.controllerTraceP95Ms &&
    countSemanticControllerNotifications(controllerTrace) ===
      EXCALIDRAW_PERFORMANCE_BUDGETS.controllerSemanticNotifications,
  routeJavaScript:
    bundle.rawBytes <= EXCALIDRAW_PERFORMANCE_BUDGETS.routeJavaScriptRawBytes &&
    bundle.gzipBytes <= EXCALIDRAW_PERFORMANCE_BUDGETS.routeJavaScriptGzipBytes,
  nodeMemory:
    memory.workingHeapDeltaBytes <=
      EXCALIDRAW_PERFORMANCE_BUDGETS.nodeWorkingHeapDeltaBytes &&
    memory.retainedHeapDeltaBytes <=
      EXCALIDRAW_PERFORMANCE_BUDGETS.nodeRetainedHeapDeltaBytes,
};

const result = {
  fixture: {
    name: "plan-00-large-scene-v1",
    elementCount: LARGE_SCENE_ELEMENT_COUNT,
    ownedPayloadBytes: Buffer.byteLength(ownedPayload),
    controllerEventCount: controllerTrace.length,
  },
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    iterations: ITERATIONS,
    warmupIterations: WARMUP_ITERATIONS,
  },
  measurements,
  memory,
  bundle,
  budgets: EXCALIDRAW_PERFORMANCE_BUDGETS,
  checks,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (Object.values(checks).some((passed) => !passed)) {
  process.exitCode = 1;
}

function measure(operation: () => unknown): {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
} {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    operation();
  }

  const durations: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);

  return {
    p50Ms: round(durations[Math.floor(durations.length * 0.5)] ?? 0),
    p95Ms: round(durations[Math.floor(durations.length * 0.95)] ?? 0),
    maxMs: round(durations.at(-1) ?? 0),
  };
}

function measureMemory(): {
  readonly workingHeapDeltaBytes: number;
  readonly retainedHeapDeltaBytes: number;
} {
  forceGarbageCollection();
  const before = process.memoryUsage().heapUsed;
  const working = allocateAndMeasureWorkingHeap();
  forceGarbageCollection();
  const retained = process.memoryUsage().heapUsed;

  return {
    workingHeapDeltaBytes: Math.max(0, working - before),
    retainedHeapDeltaBytes: Math.max(0, retained - before),
  };
}

function allocateAndMeasureWorkingHeap(): number {
  const workingSet = {
    elements: createLargeSceneElements(),
    parsed: parseDrawstuffDocument(ownedPayload),
    serialized: serializeFixture("owned-scene"),
  };
  if (workingSet.elements.length !== LARGE_SCENE_ELEMENT_COUNT) {
    throw new Error("Large-scene allocation did not use the contract fixture");
  }
  return process.memoryUsage().heapUsed;
}

function serializeFixture(profile: "owned-scene" | "readonly-share"): string {
  const createDocument =
    profile === "readonly-share"
      ? createReadonlyShareDocumentV4
      : createOwnedSceneDocumentV4;
  return serializeDrawstuffDocumentV4(
    createDocument({
      elements,
      appState: fixtureAppState,
      files: fixtureFiles,
      name: fixtureAppState.name,
    }),
  );
}

function forceGarbageCollection(): void {
  if (typeof global.gc !== "function") {
    throw new Error(
      "Run this script with node --expose-gc so memory results are comparable",
    );
  }
  global.gc();
}

function measureRouteBundle(): {
  readonly route: "/";
  readonly buildCompletedAt: string;
  readonly chunkCount: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly allChunkCount: number;
  readonly allRawBytes: number;
  readonly allGzipBytes: number;
} {
  const manifestPaths = [
    "server/app/(workspace)/page_client-reference-manifest.js",
    "server/app/(workspace)/page/react-loadable-manifest.json",
    "server/app/(workspace)/page/build-manifest.json",
  ];
  const chunks = new Set<string>();

  for (const manifestPath of manifestPaths) {
    collectJavaScriptChunks(readManifest(manifestPath), chunks);
  }

  const buildIdPath = path.join(nextDirectory, "BUILD_ID");
  const buildCompletedAt = statSync(buildIdPath).mtime;
  const newestInput = findNewestBundleInput();
  if (newestInput.modifiedAt > buildCompletedAt) {
    throw new Error(
      `Production build is stale: ${path.relative(
        repositoryDirectory,
        newestInput.path,
      )} is newer than apps/web/.next/BUILD_ID`,
    );
  }

  const routeBundle = measureChunks(chunks);
  const allChunks = new Set(
    listFiles(path.join(nextDirectory, "static/chunks"))
      .filter((filePath) => filePath.endsWith(".js"))
      .map((filePath) => path.relative(nextDirectory, filePath)),
  );
  const allBundle = measureChunks(allChunks);

  return {
    route: "/",
    buildCompletedAt: buildCompletedAt.toISOString(),
    chunkCount: chunks.size,
    rawBytes: routeBundle.rawBytes,
    gzipBytes: routeBundle.gzipBytes,
    allChunkCount: allChunks.size,
    allRawBytes: allBundle.rawBytes,
    allGzipBytes: allBundle.gzipBytes,
  };
}

function measureChunks(chunks: ReadonlySet<string>): {
  readonly rawBytes: number;
  readonly gzipBytes: number;
} {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const chunk of chunks) {
    const contents = readFileSync(path.join(nextDirectory, chunk));
    rawBytes += contents.byteLength;
    gzipBytes += gzipSync(contents).byteLength;
  }
  return { rawBytes, gzipBytes };
}

function readManifest(manifestPath: string): unknown {
  const contents = readFileSync(path.join(nextDirectory, manifestPath), "utf8");
  if (manifestPath.endsWith(".json")) {
    return JSON.parse(contents) as unknown;
  }

  const jsonStart = contents.lastIndexOf("= {");
  const jsonEnd = contents.lastIndexOf(";");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error(`Unable to parse Next.js manifest: ${manifestPath}`);
  }
  return JSON.parse(contents.slice(jsonStart + 2, jsonEnd)) as unknown;
}

function collectJavaScriptChunks(value: unknown, chunks: Set<string>): void {
  if (typeof value === "string") {
    const normalized = value.replace(/^\/_next\//, "");
    if (normalized.startsWith("static/chunks/") && normalized.endsWith(".js")) {
      chunks.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectJavaScriptChunks(entry, chunks));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) =>
      collectJavaScriptChunks(entry, chunks),
    );
  }
}

function findNewestBundleInput(): {
  readonly path: string;
  readonly modifiedAt: Date;
} {
  const inputPaths = [
    path.join(webDirectory, "src"),
    path.join(webDirectory, "package.json"),
    path.join(webDirectory, ".env"),
    path.join(webDirectory, ".env.example"),
    path.join(webDirectory, "next.config.ts"),
    path.join(webDirectory, "postcss.config.js"),
    path.join(webDirectory, "tsconfig.json"),
    path.join(repositoryDirectory, "package.json"),
    path.join(repositoryDirectory, "pnpm-lock.yaml"),
    path.join(repositoryDirectory, "pnpm-workspace.yaml"),
    path.join(repositoryDirectory, "turbo.json"),
  ];
  const files = inputPaths.filter(existsSync).flatMap(listFiles);
  return files.reduce(
    (newest, inputPath) => {
      const modifiedAt = statSync(inputPath).mtime;
      return modifiedAt > newest.modifiedAt
        ? { path: inputPath, modifiedAt }
        : newest;
    },
    {
      path: files[0] ?? webDirectory,
      modifiedAt: statSync(files[0] ?? webDirectory).mtime,
    },
  );
}

function listFiles(inputPath: string): readonly string[] {
  if (!statSync(inputPath).isDirectory()) return [inputPath];
  return readdirSync(inputPath, { withFileTypes: true }).flatMap((entry) =>
    listFiles(path.join(inputPath, entry.name)),
  );
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
