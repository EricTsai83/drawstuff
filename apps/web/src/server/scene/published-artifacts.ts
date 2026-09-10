import "server-only";

import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import type { db as database } from "@/server/db";
import { deferredFileCleanup, scene } from "@/server/db/schema";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";

type Database = typeof database;
type DatabaseExecutor =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Published render artifacts (docs/system-design/render-once-serve-many.md):
 * the author's browser exports one SVG of a published scene, carrying both
 * themes, and uploads it; the scene row points at that object and
 * `/p/[slug]` serves it without loading the engine.
 *
 * Object storage and PostgreSQL cannot share a transaction, and — unlike
 * assets — no row is written when an artifact object lands. To keep "every
 * stored object has a durable pointer", the upload handler *reserves* the key
 * in `deferred_file_cleanup` with a due time one claim window out: an object
 * whose owner never calls `publish`/`setPublishedArtifacts` (tab closed,
 * request lost) is deleted by the routine drain once the reservation falls
 * due. Claiming deletes the reservation in the same transaction that writes
 * the pointer. The claim only accepts reservations that stay undue for at
 * least {@link PUBLISHED_ARTIFACT_CLAIM_SAFETY_MARGIN_MS} more, while the
 * drain only takes due rows and reads them without a lock: for both to touch
 * the same key the claim transaction would have to stay open across the whole
 * margin, so a key is either referenced by exactly one scene row or queued for
 * deletion. Callers take `now` *after* acquiring the scene row lock so a long
 * lock wait cannot move a claim across the due line.
 */
export const PUBLISHED_ARTIFACT_RESERVATION_REASON =
  "published-artifact-unclaimed";

/** Time an uploaded artifact may wait for its claim before it is reclaimed. */
export const PUBLISHED_ARTIFACT_CLAIM_WINDOW_MS = 60 * 60 * 1000;

/**
 * A claim must land this long before the reservation falls due. The drain's
 * non-locking read of due rows and an uncommitted claim can only overlap if
 * the claim transaction outlives this margin — far beyond any request.
 */
export const PUBLISHED_ARTIFACT_CLAIM_SAFETY_MARGIN_MS = 5 * 60 * 1000;

const UPLOADTHING_FILE_HOST = /^[a-z0-9-]+\.ufs\.sh$/i;

/**
 * The URL must be the storage provider's own URL for exactly this key: the
 * viewer fetches it on behalf of every visitor, so an owner must not be able
 * to point the public page at an arbitrary origin. CSP `connect-src` pins the
 * host again on the client; this keeps the database from holding such a row.
 */
export function isUploadThingFileUrl(url: string, key: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    UPLOADTHING_FILE_HOST.test(parsed.hostname) &&
    parsed.pathname === `/f/${key}` &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

const artifactFileSchema = z
  .object({
    key: z.string().min(1).max(256),
    url: z.url(),
  })
  .refine(({ key, url }) => isUploadThingFileUrl(url, key), {
    message: "Artifact URL must be the storage URL of its key",
    path: ["url"],
  });

export const publishedArtifactsInputSchema = z.object({
  artifact: artifactFileSchema,
  /** `EXCALIDRAW_ENGINE_VERSION` of the renderer; frozen appearance marker. */
  engineVersion: z.string().min(1).max(32),
  /** Scene revision the artifact was rendered from. */
  revision: z.number().int().min(0),
});

export type PublishedArtifactsInput = z.infer<
  typeof publishedArtifactsInputSchema
>;

/**
 * Called from the upload handler once the object exists: starts the claim
 * window. Not a failure path — the reservation is what makes a lost claim safe.
 */
export async function reservePublishedArtifactUpload(
  db: DatabaseExecutor,
  params: { sceneId: string; fileKey: string; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date();
  await db.insert(deferredFileCleanup).values({
    utFileKey: params.fileKey,
    reason: PUBLISHED_ARTIFACT_RESERVATION_REASON,
    context: JSON.stringify({ sceneId: params.sceneId }),
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() + PUBLISHED_ARTIFACT_CLAIM_WINDOW_MS),
    status: "pending",
  });
}

/**
 * Consumes the reservation of the uploaded key; `false` — without touching
 * the row — when it is missing, already due, or too close to due (the drain
 * owns it now), so the caller must not reference the key.
 */
async function claimPublishedArtifactUploads(
  tx: DatabaseExecutor,
  keys: readonly string[],
  now: Date,
): Promise<boolean> {
  const claimable = and(
    inArray(deferredFileCleanup.utFileKey, [...keys]),
    eq(deferredFileCleanup.reason, PUBLISHED_ARTIFACT_RESERVATION_REASON),
    eq(deferredFileCleanup.status, "pending"),
    gt(
      deferredFileCleanup.nextAttemptAt,
      new Date(now.getTime() + PUBLISHED_ARTIFACT_CLAIM_SAFETY_MARGIN_MS),
    ),
  );
  const reserved = await tx
    .select({ id: deferredFileCleanup.id, key: deferredFileCleanup.utFileKey })
    .from(deferredFileCleanup)
    .where(claimable)
    .for("update");
  if (new Set(reserved.map(({ key }) => key)).size !== keys.length) {
    return false;
  }
  await tx.delete(deferredFileCleanup).where(
    inArray(
      deferredFileCleanup.id,
      reserved.map(({ id }) => id),
    ),
  );
  return true;
}

export type PublishedArtifactColumns = {
  publishedSvgKey: string | null;
  publishedSvgUrl: string | null;
  publishedRenderEngineVersion: string | null;
  publishedRenderedRevision: number | null;
  publishedRenderedAt: Date | null;
};

function publishedArtifactColumns(
  artifacts: PublishedArtifactsInput,
  now: Date,
): PublishedArtifactColumns {
  return {
    publishedSvgKey: artifacts.artifact.key,
    publishedSvgUrl: artifacts.artifact.url,
    publishedRenderEngineVersion: artifacts.engineVersion,
    publishedRenderedRevision: artifacts.revision,
    publishedRenderedAt: now,
  };
}

export const CLEARED_PUBLISHED_ARTIFACT_COLUMNS: PublishedArtifactColumns = {
  publishedSvgKey: null,
  publishedSvgUrl: null,
  publishedRenderEngineVersion: null,
  publishedRenderedRevision: null,
  publishedRenderedAt: null,
};

export type CurrentPublishedArtifacts = {
  keys: string[];
  renderedRevision: number | null;
};

/**
 * The scene's current artifact pointer, or `null` when the scene is gone. The
 * caller holds the scene row lock, so the answer stays true until it commits.
 */
export async function readPublishedArtifacts(
  tx: DatabaseExecutor,
  sceneId: string,
): Promise<CurrentPublishedArtifacts | null> {
  const [row] = await tx
    .select({
      key: scene.publishedSvgKey,
      renderedRevision: scene.publishedRenderedRevision,
    })
    .from(scene)
    .where(eq(scene.id, sceneId));
  if (!row) return null;
  return {
    keys: row.key === null ? [] : [row.key],
    renderedRevision: row.renderedRevision,
  };
}

export type PublishedArtifactsOutcome =
  | { applied: true }
  | {
      applied: false;
      /**
       * `unclaimed`: a reservation was missing or already due — the object is
       * the drain's. `stale`: the scene already holds artifacts rendered from a
       * newer revision (two tabs saving); the reservation expires on its own.
       */
      reason: "unclaimed" | "stale";
    };

/**
 * Points the (locked) scene row at a freshly uploaded artifact and queues the
 * one it replaces. The caller supplies the UPDATE so `publish` can flip the
 * publish state and set the slug in the same statement; when it retries a
 * slug collision it wraps this whole call in a savepoint, which also undoes
 * the claim, so a retry claims the reservation again cleanly.
 */
export async function applyPublishedArtifacts(
  tx: DatabaseExecutor,
  params: {
    sceneId: string;
    artifacts: PublishedArtifactsInput;
    now: Date;
    reason: string;
    update: (
      columns: PublishedArtifactColumns,
    ) => Promise<{ updated: boolean }>;
  },
): Promise<PublishedArtifactsOutcome> {
  const current = await readPublishedArtifacts(tx, params.sceneId);
  if (!current) return { applied: false, reason: "unclaimed" };
  if (
    current.renderedRevision !== null &&
    params.artifacts.revision < current.renderedRevision
  ) {
    return { applied: false, reason: "stale" };
  }

  const nextKeys = [params.artifacts.artifact.key];
  if (!(await claimPublishedArtifactUploads(tx, nextKeys, params.now))) {
    return { applied: false, reason: "unclaimed" };
  }

  const { updated } = await params.update(
    publishedArtifactColumns(params.artifacts, params.now),
  );
  if (!updated) return { applied: false, reason: "unclaimed" };

  const replaced = current.keys.filter((key) => !nextKeys.includes(key));
  await enqueueStorageKeyCleanup(tx, replaced, params.reason, {
    sceneId: params.sceneId,
  });
  return { applied: true };
}
