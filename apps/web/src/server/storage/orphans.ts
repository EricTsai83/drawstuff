import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@/server/collab/rooms";
import {
  collaborationAsset,
  collaborationOperation,
  deferredFileCleanup,
  fileRecord,
  scene,
} from "@/server/db/schema";
import { PUBLISHED_ARTIFACT_RESERVATION_REASON } from "@/server/scene/published-artifacts";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";

/** Cleanup reason for objects queued by reconciliation; the drain re-checks it. */
export const STORAGE_ORPHAN_REASON = "storage-orphan";

/**
 * Only objects uploaded this long ago are candidates. Every path that writes
 * a key reference does so from the upload callback of a freshly uploaded
 * object (asset records, thumbnails, room assets, published-artifact
 * reservations), so an old object gains a reference only if its callback is
 * delayed past this window; a week makes that practically impossible.
 */
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 500;
/** Pages per scan segment (10,000 objects); later segments continue from `nextOffset`. */
const MAX_PAGES = 20;
const SAMPLE_SIZE = 20;

export type StorageLister = {
  listFiles: (options: { limit: number; offset: number }) => Promise<{
    readonly files: readonly {
      readonly key: string;
      readonly size: number;
      readonly status: string;
      readonly uploadedAt: number;
    }[];
    readonly hasMore: boolean;
  }>;
};

/**
 * Which of `keys` something still points at. Every column that holds a
 * storage key is listed here, including queued cleanup and pending asset
 * finalizations. For the drain's own re-check, `forQueueTask` narrows the
 * queue to what is still a reference: a pending published-artifact
 * reservation (it may yet be claimed), never the task being processed or
 * another deletion of the same key.
 */
export async function referencedStorageKeys(
  db: Database,
  keys: readonly string[],
  options: { forQueueTask?: string } = {},
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const list = [...keys];
  const results = await Promise.all([
    db
      .select({ key: fileRecord.utFileKey })
      .from(fileRecord)
      .where(inArray(fileRecord.utFileKey, list)),
    db
      .select({ key: collaborationAsset.utFileKey })
      .from(collaborationAsset)
      .where(inArray(collaborationAsset.utFileKey, list)),
    db
      .select({ key: collaborationOperation.utFileKey })
      .from(collaborationOperation)
      .where(inArray(collaborationOperation.utFileKey, list)),
    db
      .select({ key: scene.thumbnailFileKey })
      .from(scene)
      .where(inArray(scene.thumbnailFileKey, list)),
    db
      .select({ key: scene.publishedSvgKey })
      .from(scene)
      .where(inArray(scene.publishedSvgKey, list)),
    db
      .select({ key: deferredFileCleanup.utFileKey })
      .from(deferredFileCleanup)
      .where(
        and(
          inArray(deferredFileCleanup.utFileKey, list),
          options.forQueueTask
            ? and(
                ne(deferredFileCleanup.id, options.forQueueTask),
                eq(
                  deferredFileCleanup.reason,
                  PUBLISHED_ARTIFACT_RESERVATION_REASON,
                ),
                eq(deferredFileCleanup.status, "pending"),
              )
            : undefined,
        ),
      ),
  ]);
  const referenced = new Set<string>();
  for (const rows of results)
    for (const row of rows) if (row.key) referenced.add(row.key);
  return referenced;
}

export type OrphanScan = {
  offset: number;
  scanned: number;
  /** Where the next segment starts; null when storage was listed to the end. */
  nextOffset: number | null;
  orphans: number;
  orphanBytes: number;
  sample: { key: string; size: number; uploadedAt: number }[];
  keys: string[];
};

/**
 * Lists one segment of storage, starting at `offset`, and finds old objects
 * nothing in the database points at.
 */
export async function scanStorageOrphans(
  db: Database,
  storage: StorageLister,
  offset = 0,
  now = Date.now(),
): Promise<OrphanScan> {
  const cutoff = now - ORPHAN_GRACE_MS;
  const orphans: { key: string; size: number; uploadedAt: number }[] = [];
  let scanned = 0;
  let nextOffset: number | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      nextOffset = offset + scanned;
      break;
    }
    const { files, hasMore } = await storage.listFiles({
      limit: PAGE_SIZE,
      offset: offset + page * PAGE_SIZE,
    });
    scanned += files.length;
    const candidates = files.filter(
      (file) => file.status === "Uploaded" && file.uploadedAt < cutoff,
    );
    const referenced = await referencedStorageKeys(
      db,
      candidates.map((file) => file.key),
    );
    for (const file of candidates)
      if (!referenced.has(file.key))
        orphans.push({
          key: file.key,
          size: file.size,
          uploadedAt: file.uploadedAt,
        });
    if (!hasMore) break;
  }
  return {
    offset,
    scanned,
    nextOffset,
    orphans: orphans.length,
    orphanBytes: orphans.reduce((total, file) => total + file.size, 0),
    sample: orphans.slice(0, SAMPLE_SIZE),
    keys: orphans.map((file) => file.key),
  };
}

/**
 * Rescans the same segment (never trusting an earlier preview) and queues
 * every orphan for the maintenance drain, which re-checks each key before
 * deleting it.
 */
export async function enqueueStorageOrphans(
  db: Database,
  storage: StorageLister,
  offset = 0,
  now = Date.now(),
) {
  const scan = await scanStorageOrphans(db, storage, offset, now);
  const enqueued = await enqueueStorageKeyCleanup(
    db,
    scan.keys,
    STORAGE_ORPHAN_REASON,
    { source: "reconciliation" },
  );
  return {
    offset: scan.offset,
    scanned: scan.scanned,
    nextOffset: scan.nextOffset,
    enqueued,
    orphanBytes: scan.orphanBytes,
  };
}
