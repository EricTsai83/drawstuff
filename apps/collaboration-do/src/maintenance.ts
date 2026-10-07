import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

function userTables(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    .toArray()
    .map(({ name }) => name)
    .filter(
      (name) =>
        !name.startsWith("_cf_") &&
        !name.startsWith("__cf_") &&
        !name.startsWith("sqlite_"),
    );
}

/** Closed cutover runtime. Storage is preserved unless explicit legacy cleanup is requested. */
export class CollaborationRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      for (const socket of ctx.getWebSockets()) {
        socket.close(1012, "Collaboration maintenance");
      }
      await ctx.storage.deleteAlarm();
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.origin === "https://internal.invalid" &&
      url.pathname === "/cleanup-legacy"
    )
      return this.#clearLegacyStorage().then((result) => Response.json(result));
    return maintenanceResponse();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  async #clearLegacyStorage(): Promise<{ cleared: boolean }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const tables = userTables(this.ctx.storage);
      if (tables.length > 0) {
        if (
          !tables.includes("room_meta") ||
          tables.some(
            (name) => !["room_meta", "revocation_cutoffs"].includes(name),
          )
        )
          return { cleared: false };
        const versions = this.ctx.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM room_meta",
          )
          .toArray();
        if (versions.length !== 1 || versions[0]!.schema_version !== 2)
          return { cleared: false };
      } else if ((await this.ctx.storage.list({ limit: 1 })).size > 0) {
        // Unknown KV-only storage is not a recognized legacy Room.
        return { cleared: false };
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.sync();
      return {
        cleared:
          userTables(this.ctx.storage).length === 0 &&
          (await this.ctx.storage.list({ limit: 1 })).size === 0 &&
          (await this.ctx.storage.getAlarm()) === null,
      };
    });
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(1012, "Collaboration maintenance");
  }

  webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Collaboration maintenance");
  }
}

// In stage one this export is dormant: only Room is declared in exports.
// Stage two changes only the config to provision Lifecycle with the same closed code.
export class CollaborationLifecycle extends CollaborationRoom {}

function maintenanceResponse(): Response {
  return Response.json(
    { error: "collaboration-maintenance" },
    {
      status: 503,
      headers: { "Retry-After": "300", "Cache-Control": "no-store" },
    },
  );
}

const objectSchema = z.union([
  z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9_:@.-]{1,256}$/) }),
  z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
const quiesceSchema = z.strictObject({
  namespace: z.enum(["room", "lifecycle"]),
  objects: z.array(objectSchema).min(1).max(16),
});
const encoder = new TextEncoder();

async function quiesce(
  request: Request,
  env: Env,
  cleanup = false,
): Promise<Response> {
  const expected = encoder.encode(env.COLLAB_AUTHORITY_SECRET ?? "");
  const header = request.headers.get("authorization") ?? "";
  const received = encoder.encode(
    header.startsWith("Bearer ") ? header.slice(7) : "",
  );
  if (
    expected.byteLength < 32 ||
    received.byteLength !== expected.byteLength ||
    !timingSafeEqual(received, expected)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "invalid-request" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    const chunk: unknown = part.value;
    if (!(chunk instanceof Uint8Array)) {
      await reader.cancel();
      return Response.json({ error: "invalid-request" }, { status: 400 });
    }
    size += chunk.byteLength;
    if (size > 8192) {
      await reader.cancel();
      return Response.json({ error: "request-too-large" }, { status: 413 });
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const input = quiesceSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (
    cleanup &&
    (input.namespace !== "room" ||
      input.objects.some(
        (object) =>
          !("name" in object) ||
          !/^[A-Za-z0-9_-]+-g[1-9][0-9]*$/.test(object.name),
      ))
  )
    return Response.json({ error: "invalid-legacy-target" }, { status: 400 });
  if (
    input.namespace === "lifecycle" &&
    !Object.hasOwn(env, "COLLABORATION_LIFECYCLE")
  )
    return maintenanceResponse();
  const namespace =
    input.namespace === "room"
      ? env.COLLABORATION_ROOM
      : env.COLLABORATION_LIFECYCLE;
  const clearedIds: string[] = [];
  for (const object of input.objects) {
    const stub =
      "name" in object
        ? namespace.getByName(object.name)
        : namespace.get(namespace.idFromString(object.id));
    const reply = await stub.fetch("https://internal.invalid/quiesce");
    const result: unknown = await reply.json();
    if (
      reply.status !== 503 ||
      !z
        .object({ error: z.literal("collaboration-maintenance") })
        .safeParse(result).success
    )
      return maintenanceResponse();
    if (cleanup) {
      const reply = await stub.fetch(
        "https://internal.invalid/cleanup-legacy",
        { method: "POST" },
      );
      if (
        reply.status !== 200 ||
        !z
          .strictObject({ cleared: z.literal(true) })
          .safeParse(await reply.json()).success
      )
        return Response.json({ error: "storage-not-legacy" }, { status: 409 });
      clearedIds.push(stub.id.toString());
    }
  }
  return Response.json(
    cleanup
      ? { cleared: input.objects.length, clearedIds }
      : { quiesced: input.objects.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      ![
        "/internal/cutover/quiesce",
        "/internal/cutover/cleanup-legacy",
      ].includes(path)
    )
      return maintenanceResponse();
    try {
      return await quiesce(
        request,
        env,
        path === "/internal/cutover/cleanup-legacy",
      );
    } catch (error) {
      return error instanceof z.ZodError || error instanceof SyntaxError
        ? Response.json({ error: "invalid-request" }, { status: 400 })
        : maintenanceResponse();
    }
  },
} satisfies ExportedHandler<Env>;
