import { z } from "zod";
import { env } from "@/env";
import { requiresCanonicalWhiteboardReads } from "@/config/whiteboard-cutover";
import {
  getWhiteboardConvergenceReadiness,
  runWhiteboardConvergenceBatch,
} from "@/server/whiteboard/data-convergence";

const requestSchema = z
  .object({
    mode: z.enum(["apply", "dry-run"]),
    cursor: z.uuid().optional(),
    batchSize: z.number().int().min(1).max(100).default(25),
    abortAfterFailures: z.number().int().min(1).max(20).default(1),
    readiness: z
      .object({
        inventoryComplete: z.literal(true),
        snapshotCreated: z.literal(true),
        restoreTested: z.literal(true),
        zeroLegacyWrites: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({
    ...(await getWhiteboardConvergenceReadiness()),
    canonicalReadsRequired: requiresCanonicalWhiteboardReads(),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  if (parsed.data.mode === "apply" && !parsed.data.readiness) {
    return Response.json(
      { error: "readiness-acknowledgements-required" },
      { status: 409 },
    );
  }

  try {
    const batch = await runWhiteboardConvergenceBatch({
      apply: parsed.data.mode === "apply",
      cursor: parsed.data.cursor,
      batchSize: parsed.data.batchSize,
      abortAfterFailures: parsed.data.abortAfterFailures,
    });
    const readiness = {
      ...(await getWhiteboardConvergenceReadiness()),
      canonicalReadsRequired: requiresCanonicalWhiteboardReads(),
    };
    console.info("whiteboard-convergence", {
      mode: parsed.data.mode,
      audits: batch.audits,
      stoppedAfterFailure: batch.stoppedAfterFailure,
      readiness,
    });
    return Response.json({ ...batch, readiness });
  } catch (error: unknown) {
    console.error("whiteboard-convergence-failed", {
      mode: parsed.data.mode,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json({ error: "convergence-failed" }, { status: 500 });
  }
}

function isAuthorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}
