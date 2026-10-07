/** Deletes only manifest-listed protocol-5 Room storage through the maintenance runtime. */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolve } from "node:path";

const [base, manifestFile, resultFile] = process.argv.slice(2);
if (!base || !manifestFile || !resultFile || process.argv.length !== 5) {
  console.error(
    "Usage: cleanup:legacy <https-worker-origin> <before-report.json> <result-report.json>",
  );
  process.exit(1);
}
try {
  const url = new URL(base),
    secret = process.env.COLLAB_AUTHORITY_SECRET;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    resolve(manifestFile) === resolve(resultFile)
  )
    throw new Error("Invalid configuration");
  const manifest = z
    .object({
      phase: z.literal("before"),
      oldRoomNames: z.array(z.string().regex(/^[A-Za-z0-9_-]+-g[1-9][0-9]*$/)),
    })
    .parse(JSON.parse(await readFile(manifestFile, "utf8")));
  const names = [...new Set(manifest.oldRoomNames)];
  const report = {
    version: 1,
    origin: url.origin,
    manifestFile,
    startedAt: new Date().toISOString(),
    clearedRoomNames: [],
    clearedRoomIds: [],
    status: "in-progress",
  };
  const save = () =>
    writeFile(resultFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(resultFile, JSON.stringify(report, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    for (let offset = 0; offset < names.length; offset += 16) {
      const batch = names.slice(offset, offset + 16);
      const response = await fetch(
        new URL("/internal/cutover/cleanup-legacy", url),
        {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            namespace: "room",
            objects: batch.map((name) => ({ name })),
          }),
        },
      );
      if (response.status !== 200) throw new Error("Unacknowledged cleanup");
      const ack = z
        .strictObject({
          cleared: z.literal(batch.length),
          clearedIds: z
            .array(z.string().regex(/^[a-f0-9]{64}$/))
            .length(batch.length),
        })
        .parse(await response.json());
      if (new Set(ack.clearedIds).size !== batch.length)
        throw new Error("Duplicate cleanup IDs");
      report.clearedRoomNames.push(...batch);
      report.clearedRoomIds.push(...ack.clearedIds);
      await save();
    }
    report.status = "completed";
    report.completedAt = new Date().toISOString();
    await save();
    console.log(
      `Cleared manifest-listed legacy Rooms: ${report.clearedRoomNames.length}. Result: ${resultFile}. New Rooms and Lifecycle are excluded.`,
    );
  } catch (error) {
    report.status = "incomplete";
    await save();
    throw error;
  }
} catch {
  console.error(
    "Legacy cleanup failed. Check the result report and maintenance deployment; unacknowledged batches may be retried. No DB or provider objects were deleted.",
  );
  process.exitCode = 1;
}
