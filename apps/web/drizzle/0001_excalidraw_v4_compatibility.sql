-- Stage 1 of the V4 rollout: allow the application to read legacy raw
-- Excalidraw (V2), owned Whiteboard (V3), and native Excalidraw (V4)
-- documents at the same time. Run this before deploying V4 writes.
--
-- This migration does not rewrite scene payloads. Use
-- `pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --validate` against
-- a database clone, then execute the checksum-gated migration while writes
-- are paused.

ALTER TABLE "excalidraw-ericts_scene"
  ADD COLUMN IF NOT EXISTS "document_version" integer;

ALTER TABLE "excalidraw-ericts_shared_scene"
  ADD COLUMN IF NOT EXISTS "document_version" integer;

-- Databases created before the owned-engine cutover contain raw Excalidraw
-- payloads. A V3 database already has non-null version values, so these
-- updates do not relabel it.
UPDATE "excalidraw-ericts_scene"
SET "document_version" = 2
WHERE "document_version" IS NULL;

UPDATE "excalidraw-ericts_shared_scene"
SET "document_version" = 2
WHERE "document_version" IS NULL;

ALTER TABLE "excalidraw-ericts_scene"
  ALTER COLUMN "document_version" SET DEFAULT 4,
  ALTER COLUMN "document_version" SET NOT NULL;

ALTER TABLE "excalidraw-ericts_shared_scene"
  ALTER COLUMN "document_version" SET DEFAULT 4,
  ALTER COLUMN "document_version" SET NOT NULL;

ALTER TABLE "excalidraw-ericts_scene"
  DROP CONSTRAINT IF EXISTS "scene_document_version_current";

ALTER TABLE "excalidraw-ericts_scene"
  DROP CONSTRAINT IF EXISTS "scene_document_version_supported";

ALTER TABLE "excalidraw-ericts_scene"
  ADD CONSTRAINT "scene_document_version_supported"
  CHECK ("document_version" IN (2, 3, 4));

ALTER TABLE "excalidraw-ericts_shared_scene"
  DROP CONSTRAINT IF EXISTS "shared_scene_document_version_current";

ALTER TABLE "excalidraw-ericts_shared_scene"
  DROP CONSTRAINT IF EXISTS "shared_scene_document_version_supported";

ALTER TABLE "excalidraw-ericts_shared_scene"
  ADD CONSTRAINT "shared_scene_document_version_supported"
  CHECK ("document_version" IN (2, 3, 4));
