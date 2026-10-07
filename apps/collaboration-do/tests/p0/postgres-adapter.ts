import postgres from "postgres";
import { z } from "zod";
import {
  checksum,
  MAX_BINARY_BYTES,
  operationSchema,
  type Operation,
  type OperationResult,
} from "./contracts.ts";

type HostRequest = {
  url: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
};
type Gate = { reached: boolean; wait: Promise<void>; release(): void };

export async function createPostgresAdapter(url: string) {
  const sql = postgres(url, {
    max: 8,
    connection: { application_name: "drawstuff-p0" },
  });
  // Only the wrapper-created disposable DB is accepted by the config.
  await sql`CREATE TABLE p0_room (id text PRIMARY KEY, epoch integer NOT NULL DEFAULT 1, revision integer NOT NULL DEFAULT 0, payload bytea, checksum text, ended boolean NOT NULL DEFAULT false)`;
  await sql`CREATE TABLE p0_result (room_id text NOT NULL REFERENCES p0_room(id), operation_id uuid NOT NULL, fingerprint text NOT NULL, status text NOT NULL, revision integer, PRIMARY KEY(room_id, operation_id))`;
  // Provider ciphertext is held by the host fixture, never in DO SQLite.
  await sql`CREATE TABLE p0_asset (room_id text NOT NULL REFERENCES p0_room(id), id uuid NOT NULL, epoch integer NOT NULL, checksum text NOT NULL, payload bytea NOT NULL, finalized boolean NOT NULL DEFAULT false, PRIMARY KEY(room_id,id))`;
  const gates = new Map<string, Gate>();
  const dropped = new Set<string>();
  const reports: unknown[] = [];
  let unavailable = false;
  const pause = async (id: string): Promise<void> => {
    const gate = gates.get(id);
    if (!gate) return;
    gate.reached = true;
    await gate.wait;
  };
  const execute = async (
    operation: Operation,
    payload?: Uint8Array,
  ): Promise<OperationResult> => {
    if (payload) await pause(`before:${operation.operationId}`);
    return sql.begin(async (tx) => {
      await tx`INSERT INTO p0_room(id) VALUES (${operation.roomId}) ON CONFLICT DO NOTHING`;
      const [room] = await tx<
        { epoch: number; revision: number; ended: boolean }[]
      >`SELECT epoch, revision, ended FROM p0_room WHERE id = ${operation.roomId} FOR UPDATE`;
      if (!room) throw new Error("missing-room");
      await pause(`locked:${operation.operationId}`);
      const [existing] = await tx<
        {
          fingerprint: string;
          status: OperationResult["status"];
          revision: number | null;
        }[]
      >`SELECT fingerprint, status, revision FROM p0_result WHERE room_id = ${operation.roomId} AND operation_id = ${operation.operationId}`;
      const fingerprint = JSON.stringify(operation);
      if (existing) {
        return existing.fingerprint === fingerprint
          ? { status: existing.status, revision: existing.revision }
          : { status: "refused", revision: null };
      }
      let result: OperationResult;
      if (!payload) result = { status: "cancelled", revision: null };
      else if (
        room.ended ||
        room.epoch !== operation.epoch ||
        Date.now() >= operation.deadline
      )
        result = { status: "refused", revision: null };
      else if (room.revision !== operation.expectedRevision)
        result = { status: "conflict", revision: room.revision };
      else {
        for (const id of operation.assetIds ?? []) {
          const [asset] = await tx<
            { finalized: boolean }[]
          >`SELECT finalized FROM p0_asset WHERE room_id=${operation.roomId} AND id=${id}`;
          if (!asset?.finalized) return { status: "pending", revision: null };
        }
        const revision = room.revision + 1;
        await tx`UPDATE p0_room SET payload = ${Buffer.from(payload)}, checksum=${operation.checksum}, revision = ${revision} WHERE id = ${operation.roomId}`;
        result = { status: "written", revision };
      }
      await tx`INSERT INTO p0_result(room_id, operation_id, fingerprint, status, revision) VALUES (${operation.roomId}, ${operation.operationId}, ${fingerprint}, ${result.status}, ${result.revision})`;
      return result;
    });
  };

  return {
    async fetch(request: HostRequest): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/test/")) {
        const input = z
          .object({
            id: z.string().optional(),
            unavailable: z.boolean().optional(),
            report: z.unknown().optional(),
          })
          .parse(await request.json());
        if (path === "/test/hold" && input.id) {
          let release = (): void => undefined;
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          gates.set(input.id, { reached: false, wait, release });
        }
        if (path === "/test/release" && input.id)
          gates.get(input.id)?.release();
        if (path === "/test/drop" && input.id) dropped.add(input.id);
        if (path === "/test/prune" && input.id)
          await sql`DELETE FROM p0_result WHERE operation_id = ${input.id}`;
        if (path === "/test/fault") unavailable = input.unavailable === true;
        if (path === "/test/report") {
          reports.push(input.report);
          console.log("P0 scenario", JSON.stringify(input.report));
        }
        if (path === "/test/reset") {
          await sql`DELETE FROM p0_asset`;
          await sql`DELETE FROM p0_result`;
          await sql`DELETE FROM p0_room`;
        }
        const locks = await sql<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'drawstuff-p0' AND wait_event_type = 'Lock'`;
        const sessions = await sql<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'drawstuff-p0'`;
        return Response.json({
          reached: input.id ? (gates.get(input.id)?.reached ?? false) : false,
          locks: locks[0]?.count ?? 0,
          sessions: sessions[0]?.count ?? 0,
        });
      }
      if (unavailable) return new Response(null, { status: 503 });
      if (path === "/fence") {
        const input = z
          .object({
            roomId: z.string(),
            epoch: z.int().positive(),
            closed: z.boolean().optional(),
          })
          .parse(await request.json());
        await sql.begin(async (tx) => {
          await tx`INSERT INTO p0_room(id) VALUES (${input.roomId}) ON CONFLICT DO NOTHING`;
          await tx`SELECT id FROM p0_room WHERE id = ${input.roomId} FOR UPDATE`;
          await tx`UPDATE p0_room SET epoch = greatest(epoch, ${input.epoch}), ended=ended OR ${input.closed ?? false} WHERE id = ${input.roomId}`;
        });
        return Response.json({ status: "enforced" });
      }
      if (path === "/cleanup") {
        const input = z
          .object({ roomId: z.string() })
          .parse(await request.json());
        await sql.begin(async (tx) => {
          const [room] = await tx<
            { ended: boolean }[]
          >`SELECT ended FROM p0_room WHERE id=${input.roomId} FOR UPDATE`;
          if (!room?.ended) throw new Error("cleanup-before-fence");
          await tx`DELETE FROM p0_asset WHERE room_id=${input.roomId}`;
          await tx`UPDATE p0_room SET payload=NULL WHERE id=${input.roomId}`;
        });
        return Response.json({ status: "cleaned" });
      }
      const operation = operationSchema.parse(
        JSON.parse(request.headers.get("x-p0-operation") ?? "null") as unknown,
      );
      if (path === "/verify-initialization") {
        const verified = await sql.begin(async (tx) => {
          const [room] = await tx<
            {
              epoch: number;
              revision: number;
              checksum: string;
              ended: boolean;
            }[]
          >`SELECT epoch,revision,checksum,ended FROM p0_room WHERE id=${operation.roomId} FOR UPDATE`;
          if (
            !room ||
            room.ended ||
            room.epoch !== operation.epoch ||
            room.revision !== operation.expectedRevision + 1 ||
            room.checksum !== operation.checksum
          )
            return false;
          for (const id of operation.assetIds ?? []) {
            const [asset] = await tx<
              { finalized: boolean }[]
            >`SELECT finalized FROM p0_asset WHERE room_id=${operation.roomId} AND id=${id}`;
            if (!asset?.finalized) return false;
          }
          return true;
        });
        return Response.json({ verified });
      }
      if (path === "/asset-upload" || path === "/asset-finalize") {
        let bytes: Uint8Array | undefined;
        if (path === "/asset-upload") {
          bytes = new Uint8Array(await request.arrayBuffer());
          if (!bytes.length || bytes.length > MAX_BINARY_BYTES)
            return new Response(null, { status: 413 });
          if ((await checksum(bytes)) !== operation.checksum)
            return new Response(null, { status: 400 });
          await pause(`upload:${operation.operationId}`);
        }
        const payload = bytes;
        const accepted = await sql.begin(async (tx) => {
          await tx`INSERT INTO p0_room(id) VALUES (${operation.roomId}) ON CONFLICT DO NOTHING`;
          const [room] = await tx<
            { epoch: number; ended: boolean }[]
          >`SELECT epoch,ended FROM p0_room WHERE id=${operation.roomId} FOR UPDATE`;
          if (
            !room ||
            room.ended ||
            room.epoch !== operation.epoch ||
            Date.now() >= operation.deadline
          )
            return false;
          if (payload) {
            await tx`INSERT INTO p0_asset(room_id,id,epoch,checksum,payload) VALUES (${operation.roomId},${operation.operationId},${operation.epoch},${operation.checksum},${Buffer.from(payload)}) ON CONFLICT DO NOTHING`;
          }
          const [asset] = await tx<
            { checksum: string }[]
          >`SELECT checksum FROM p0_asset WHERE room_id=${operation.roomId} AND id=${operation.operationId}`;
          if (asset?.checksum !== operation.checksum) return false;
          if (!payload)
            await tx`UPDATE p0_asset SET finalized=true WHERE room_id=${operation.roomId} AND id=${operation.operationId}`;
          return true;
        });
        return Response.json({
          status: accepted ? "written" : "refused",
          revision: null,
        });
      }
      if (path === "/asset-index") {
        const assets = await sql<
          { id: string }[]
        >`SELECT id FROM p0_asset WHERE room_id=${operation.roomId} AND finalized=true ORDER BY id`;
        return Response.json({ assetIds: assets.map((asset) => asset.id) });
      }
      if (path === "/asset-read") {
        const [asset] = await sql<
          { payload: Uint8Array }[]
        >`SELECT payload FROM p0_asset WHERE room_id=${operation.roomId} AND id=${operation.operationId} AND finalized=true`;
        return new Response(asset ? new Uint8Array(asset.payload) : null, {
          status: asset ? 200 : 404,
        });
      }
      if (path === "/read") {
        const [room] = await sql<
          { payload: Uint8Array | null; revision: number }[]
        >`SELECT payload, revision FROM p0_room WHERE id = ${operation.roomId}`;
        return new Response(
          room?.payload ? new Uint8Array(room.payload) : null,
          {
            status: room?.payload ? 200 : 404,
            headers: {
              "x-p0-revision": String(room?.revision ?? 0),
              "content-type": "application/octet-stream",
            },
          },
        );
      }
      if (path === "/status") {
        const [result] = await sql<
          {
            fingerprint: string;
            status: OperationResult["status"];
            revision: number | null;
          }[]
        >`SELECT fingerprint, status, revision FROM p0_result WHERE room_id = ${operation.roomId} AND operation_id = ${operation.operationId}`;
        return Response.json(
          result?.fingerprint === JSON.stringify(operation)
            ? { status: result.status, revision: result.revision }
            : { status: "pending", revision: null },
        );
      }
      let payload: Uint8Array | undefined;
      if (path === "/write") {
        payload = new Uint8Array(await request.arrayBuffer());
        if (!payload.length || payload.length > MAX_BINARY_BYTES)
          return new Response(null, { status: 413 });
        if ((await checksum(payload)) !== operation.checksum)
          return new Response(null, { status: 400 });
      } else if (path !== "/cancel") return new Response(null, { status: 404 });
      const result = await execute(operation, payload);
      if (dropped.delete(operation.operationId))
        return new Response(null, { status: 503 });
      return Response.json(result);
    },
    async close(): Promise<void> {
      for (const gate of gates.values()) gate.release();
      await sql.end({ timeout: 5 });
    },
    reports,
  };
}
