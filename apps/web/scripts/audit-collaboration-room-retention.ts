/**
 * Read-only audit of collaboration room retention.
 *
 * For every collaboration room, reports whether it is still live, ended, or
 * expired, and what durable data it still holds:
 *
 * - snapshot rows (Postgres ciphertext) with their byte totals
 * - asset rows whose storage objects are still referenced
 * - which rooms are past the retention grace period and would be reclaimed
 *
 * Run from apps/web:
 *
 *   pnpm exec tsx --env-file=.env scripts/audit-collaboration-room-retention.ts
 */

import postgres from "postgres";

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("POSTGRES_URL is not set");
  const sql = postgres(url, { max: 1 });

  try {
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - GRACE_MS);

    type RoomRow = {
      roomId: string;
      status: string;
      expiresAt: Date;
      endedAt: Date | null;
      updatedAt: Date;
      snapshotRows: number;
      snapshotBytes: number;
      assetRows: number;
      assetBytes: number;
    };
    const rooms = await sql<RoomRow[]>`
      select
        r.room_id as "roomId",
        r.status,
        r.expires_at as "expiresAt",
        r.ended_at as "endedAt",
        r.updated_at as "updatedAt",
        coalesce(s.rows, 0)::int as "snapshotRows",
        coalesce(s.bytes, 0)::int as "snapshotBytes",
        coalesce(a.rows, 0)::int as "assetRows",
        coalesce(a.bytes, 0)::int as "assetBytes"
      from "drawstuff_collaboration_room" r
      left join (
        select room_id, count(*) as rows, sum(byte_length) as bytes
        from "drawstuff_collaboration_snapshot" group by room_id
      ) s on s.room_id = r.room_id
      left join (
        select room_id, count(*) as rows, sum(byte_length) as bytes
        from "drawstuff_collaboration_asset" group by room_id
      ) a on a.room_id = r.room_id
      order by r.created_at`;

    const isEnded = (room: RoomRow) => room.status === "ended";
    const isExpired = (room: RoomRow) =>
      room.status === "active" && room.expiresAt.getTime() <= now.getTime();
    const isLive = (room: RoomRow) => !isEnded(room) && !isExpired(room);
    const leftLiveWindowAt = (room: RoomRow) =>
      isEnded(room) ? (room.endedAt ?? room.updatedAt) : room.expiresAt;
    const holdsData = (room: RoomRow) =>
      room.snapshotRows > 0 || room.assetRows > 0;
    const pastGrace = (room: RoomRow) =>
      !isLive(room) && leftLiveWindowAt(room).getTime() < graceCutoff.getTime();
    const reclaimable = (room: RoomRow) => pastGrace(room) && holdsData(room);
    // Data-less but still refreshable by the create mutation: retention ends
    // these rather than reclaiming anything from them.
    const endableEmptyExpired = (room: RoomRow) =>
      pastGrace(room) && isExpired(room) && !holdsData(room);

    const sum = (items: RoomRow[], pick: (room: RoomRow) => number) =>
      items.reduce((total, item) => total + pick(item), 0);
    const summarize = (items: RoomRow[]) => ({
      rooms: items.length,
      snapshotRows: sum(items, (room) => room.snapshotRows),
      snapshotBytes: sum(items, (room) => room.snapshotBytes),
      assetRows: sum(items, (room) => room.assetRows),
      assetBytes: sum(items, (room) => room.assetBytes),
    });

    console.log(
      JSON.stringify(
        {
          auditedAt: now.toISOString(),
          graceDays: GRACE_MS / (24 * 60 * 60 * 1000),
          totals: summarize(rooms),
          live: summarize(rooms.filter(isLive)),
          ended: summarize(rooms.filter(isEnded)),
          expiredStillActive: summarize(rooms.filter(isExpired)),
          endedOrExpiredHoldingData: summarize(
            rooms.filter((room) => !isLive(room) && holdsData(room)),
          ),
          reclaimablePastGrace: summarize(rooms.filter(reclaimable)),
          endableEmptyExpiredPastGrace:
            rooms.filter(endableEmptyExpired).length,
          reclaimableRooms: rooms.filter(reclaimable).map((room) => ({
            roomId: room.roomId,
            status: room.status,
            leftLiveWindowAt: leftLiveWindowAt(room).toISOString(),
            snapshotRows: room.snapshotRows,
            snapshotBytes: room.snapshotBytes,
            assetRows: room.assetRows,
            assetBytes: room.assetBytes,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
