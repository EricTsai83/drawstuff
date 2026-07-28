-- PROPOSAL ONLY. Do not apply to production.
--
-- Promote this file to a numbered migration only after:
--   1. the preflight report returns no empty IDs or parent-scoped collisions;
--   2. decoded owned-scene references all resolve exactly once;
--   3. an isolated integration database and production clone pass rollback.

-- Preflight: file_record.name currently carries the Excalidraw fileId because
-- upload clients use the fileId as the upload filename.
SELECT id, scene_id, shared_scene_id, name
FROM "excalidraw-ericts_file_record"
WHERE btrim(name) = '';

-- Preflight: these rows would violate the proposed identity constraints.
SELECT
  scene_id,
  name AS excalidraw_file_id,
  count(*) AS record_count,
  array_agg(id ORDER BY id) AS record_ids
FROM "excalidraw-ericts_file_record"
WHERE scene_id IS NOT NULL
GROUP BY scene_id, name
HAVING count(*) > 1;

SELECT
  shared_scene_id,
  name AS excalidraw_file_id,
  count(*) AS record_count,
  array_agg(id ORDER BY id) AS record_ids
FROM "excalidraw-ericts_file_record"
WHERE shared_scene_id IS NOT NULL
GROUP BY shared_scene_id, name
HAVING count(*) > 1;

BEGIN;

ALTER TABLE "excalidraw-ericts_file_record"
  ADD COLUMN "excalidraw_file_id" varchar(256);

UPDATE "excalidraw-ericts_file_record"
SET "excalidraw_file_id" = name
WHERE "excalidraw_file_id" IS NULL;

ALTER TABLE "excalidraw-ericts_file_record"
  ALTER COLUMN "excalidraw_file_id" SET NOT NULL;

ALTER TABLE "excalidraw-ericts_file_record"
  ADD CONSTRAINT "file_record_excalidraw_file_id_nonempty"
  CHECK (btrim("excalidraw_file_id") <> '');

DROP INDEX IF EXISTS "file_record_shared_scene_name_unique";

CREATE UNIQUE INDEX "file_record_scene_excalidraw_file_id_unique"
  ON "excalidraw-ericts_file_record" ("scene_id", "excalidraw_file_id")
  WHERE "scene_id" IS NOT NULL;

CREATE UNIQUE INDEX "file_record_shared_scene_excalidraw_file_id_unique"
  ON "excalidraw-ericts_file_record"
    ("shared_scene_id", "excalidraw_file_id")
  WHERE "shared_scene_id" IS NOT NULL;

-- Equal bytes do not imply equal Excalidraw identity. Different fileIds may
-- point at equal content, especially after copy/paste or scene reconciliation.
DROP INDEX IF EXISTS "file_record_scene_content_hash_unique";

CREATE INDEX "file_record_scene_content_hash_idx"
  ON "excalidraw-ericts_file_record" ("scene_id", "content_hash")
  WHERE "scene_id" IS NOT NULL AND "content_hash" IS NOT NULL;

COMMIT;

-- Postflight: run the application-level decoded reference report. Encrypted
-- readonly shares cannot be decoded server-side and must be validated by the
-- client during open/re-share.
