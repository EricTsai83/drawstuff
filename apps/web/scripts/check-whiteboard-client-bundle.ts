import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const FORBIDDEN_MARKERS = [
  "parseWhiteboardDocumentV2",
  "createWhiteboardDocumentV2",
  "Expected whiteboard document version 2",
  ...(process.env.NEXT_PUBLIC_WHITEBOARD_TEST_MODE === "1"
    ? []
    : ["__DRAWSTUFF_WHITEBOARD_TEST__"]),
] as const;

const chunkRoot = join(process.cwd(), ".next", "static", "chunks");
const files = await collectJavaScriptFiles(chunkRoot);
const violations: string[] = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const marker of FORBIDDEN_MARKERS) {
    if (source.includes(marker)) {
      violations.push(`${file}: ${marker}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `V2 whiteboard code leaked into client chunks:\n${violations.join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} client chunks: V3-only\n`);
}

async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectJavaScriptFiles(path);
      return extname(entry.name) === ".js" ? [path] : [];
    }),
  );
  return nested.flat().sort();
}
