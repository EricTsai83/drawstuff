-- Read-only protocol-5 manifest. Export both result sets before upgrade.sql.
-- Keep the export until object cleanup is verified; never delete objects from this query automatically.
SELECT DISTINCT a.ut_file_key
FROM drawstuff_collaboration_asset a
WHERE NOT EXISTS (SELECT 1 FROM drawstuff_file_record f WHERE f.ut_file_key = a.ut_file_key)
  AND NOT EXISTS (SELECT 1 FROM drawstuff_scene s
    WHERE s.thumbnail_file_key = a.ut_file_key OR s.published_svg_key = a.ut_file_key)
ORDER BY a.ut_file_key;

-- Known protocol-5 DO names. Earlier rotated generations may need namespace inventory/log evidence too.
SELECT room_id, auth_generation, room_id || '-g' || auth_generation::text AS old_do_name
FROM drawstuff_collaboration_room
UNION
SELECT room_id, auth_generation, room_id || '-g' || auth_generation::text
FROM drawstuff_collaboration_asset
UNION
SELECT room_id, auth_generation, room_id || '-g' || auth_generation::text
FROM drawstuff_collaboration_snapshot;
