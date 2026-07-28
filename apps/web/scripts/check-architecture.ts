import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dirname, "../src");
const packageJsonPath = path.resolve(import.meta.dirname, "../package.json");
const violations: string[] = [];
const forbidden = [
  { pattern: /@radix-ui\//, reason: "direct Radix import" },
  { pattern: /OwnedWhiteboardCanvas/, reason: "owned canvas runtime" },
  { pattern: /@drawstuff\/whiteboard/, reason: "owned whiteboard package" },
  {
    pattern: /clearElementsForDatabase/,
    reason: "lossy native element projection",
  },
];

for (const file of walk(sourceRoot)) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      violations.push(`${path.relative(sourceRoot, file)}: ${rule.reason}`);
    }
  }
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
  string,
  Record<string, string>
>;
if (packageJson.dependencies?.["@excalidraw/excalidraw"] !== "0.18.1") {
  violations.push(
    "package.json: @excalidraw/excalidraw must remain exactly pinned to 0.18.1",
  );
}
if (packageJson.dependencies?.["@drawstuff/whiteboard"]) {
  violations.push("package.json: owned whiteboard dependency is forbidden");
}

const snapshotSource = readFileSync(
  path.join(sourceRoot, "lib/excalidraw.ts"),
  "utf8",
);
if (!snapshotSource.includes("getSceneElementsIncludingDeleted()")) {
  violations.push(
    "lib/excalidraw.ts: cloud snapshots must retain deleted tombstones",
  );
}

const documentCodecSource = readFileSync(
  path.join(sourceRoot, "lib/excalidraw-document-v4.ts"),
  "utf8",
);
if (!documentCodecSource.includes("selectOfficialServerAppState")) {
  violations.push(
    "lib/excalidraw-document-v4.ts: cloud appState must use the pinned shared adapter",
  );
}

const readonlyShareSource = readFileSync(
  path.join(sourceRoot, "hooks/use-scene-export.ts"),
  "utf8",
);
if (!readonlyShareSource.includes('profile: "readonly-share"')) {
  violations.push(
    "hooks/use-scene-export.ts: readonly shares must use the readonly-share profile",
  );
}

const ownedSceneSource = readFileSync(
  path.join(sourceRoot, "hooks/use-cloud-upload.ts"),
  "utf8",
);
if (!ownedSceneSource.includes('profile: "owned-scene"')) {
  violations.push(
    "hooks/use-cloud-upload.ts: owned saves must use the owned-scene profile",
  );
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Excalidraw architecture guard passed\n");
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
