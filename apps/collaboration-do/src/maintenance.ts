import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

/** Closed cutover runtime. Preserves storage for rollback; never calls adapters. */
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

  fetch(_request: Request): Response {
    return maintenanceResponse();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
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

async function quiesce(request: Request, env: Env): Promise<Response> {
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
    input.namespace === "lifecycle" &&
    !Object.hasOwn(env, "COLLABORATION_LIFECYCLE")
  )
    return maintenanceResponse();
  const namespace =
    input.namespace === "room"
      ? env.COLLABORATION_ROOM
      : env.COLLABORATION_LIFECYCLE;
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
  }
  return Response.json(
    { quiesced: input.objects.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/internal/cutover/quiesce"
    )
      return maintenanceResponse();
    try {
      return await quiesce(request, env);
    } catch (error) {
      return error instanceof z.ZodError || error instanceof SyntaxError
        ? Response.json({ error: "invalid-request" }, { status: 400 })
        : maintenanceResponse();
    }
  },
} satisfies ExportedHandler<Env>;
