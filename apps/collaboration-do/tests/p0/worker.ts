import { DurableObject } from "cloudflare:workers";
import {
  boundedBody,
  checksum,
  NORMAL_QUEUE_LIMIT,
  OPERATION_TTL_MS,
  operationSchema,
  resultSchema,
  type Operation,
  type OperationResult,
  SECURITY_QUEUE_LIMIT,
  MANAGEMENT_RESULT_LIMIT,
  INITIALIZATION_TTL_MS,
  BODY_CONCURRENCY_LIMIT,
  ALARM_BUDGET_MS,
  EXTERNAL_TIMEOUT_MS,
} from "./contracts.ts";
import { WorkBudget } from "./work-budget.ts";

export interface P0Env {
  P0_ROOM: DurableObjectNamespace<StorageBarrierPrototype>;
  P0_ADAPTER: Fetcher;
}
type Stored = {
  id: string;
  metadata: string;
  status: OperationResult["status"];
  revision: number | null;
};

export class StorageBarrierPrototype extends DurableObject<P0Env> {
  private readonly work: WorkBudget;
  private bodies = 0;
  constructor(ctx: DurableObjectState, env: P0Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, writer_revoked INTEGER NOT NULL, fence_pending INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO authority VALUES (1,1,0,0,0)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS security (subject TEXT PRIMARY KEY, epoch INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS management (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS initialization (id INTEGER PRIMARY KEY CHECK(id=1), create_id TEXT NOT NULL, checksum TEXT NOT NULL, assets TEXT NOT NULL, deadline INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    this.work = new WorkBudget(ctx.storage);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER)",
    );
  }
  private authority() {
    return this.ctx.storage.sql
      .exec<{
        epoch: number;
        writer_revoked: number;
        fence_pending: number;
        closed: number;
      }>("SELECT * FROM authority")
      .one();
  }
  private async adapter(
    path: string,
    operation: Operation,
    bytes?: Uint8Array,
    timeout = EXTERNAL_TIMEOUT_MS,
  ): Promise<Response> {
    return this.external(
      `http://adapter${path}`,
      {
        method: "POST",
        headers: {
          "x-p0-operation": JSON.stringify(operation),
          "content-type": "application/octet-stream",
        },
        body: bytes ? new Uint8Array(bytes) : undefined,
      },
      timeout,
    );
  }
  private async external(
    url: string,
    init: RequestInit,
    timeout = EXTERNAL_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await this.env.P0_ADAPTER.fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      return new Response(null, { status: 503 });
    } finally {
      clearTimeout(timer);
    }
  }
  private record(operation: Operation, result: OperationResult): void {
    this.ctx.storage.sql.exec(
      "UPDATE operations SET status=?, revision=? WHERE id=?",
      result.status,
      result.revision,
      operation.operationId,
    );
    if (result.status !== "pending") this.work.terminal(operation.operationId);
  }
  private async settle(
    operation: Operation,
    path: "/status" | "/cancel",
    timeout = EXTERNAL_TIMEOUT_MS,
  ): Promise<OperationResult> {
    const response = await this.adapter(path, operation, undefined, timeout);
    if (!response.ok) return { status: "pending", revision: null };
    const result = resultSchema.parse(await response.json());
    this.record(operation, result);
    return result;
  }
  private async fence(
    roomId: string,
    timeout = EXTERNAL_TIMEOUT_MS,
  ): Promise<Response> {
    const authority = this.authority();
    const response = await this.external(
      "http://adapter/fence",
      {
        method: "POST",
        body: JSON.stringify({
          roomId,
          epoch: authority.epoch,
          closed: !!authority.closed,
        }),
      },
      timeout,
    );
    if (!response.ok)
      return Response.json({ status: "pending" }, { status: 202 });
    await this.work.commit(() => {
      this.ctx.storage.sql.exec(
        "UPDATE authority SET fence_pending=0 WHERE epoch=?",
        authority.epoch,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM security WHERE epoch<=?",
        authority.epoch,
      );
      const done = this.ctx.storage.sql
        .exec<{ id: string }>(
          "UPDATE management SET status='enforced' WHERE epoch<=? AND status='pending' RETURNING id",
          authority.epoch,
        )
        .toArray();
      for (const row of done) this.work.terminal(row.id);
      if (!this.authority().fence_pending) this.work.done("fence");
    });
    return Response.json({ status: "enforced" });
  }
  async alarm(): Promise<void> {
    const start = Date.now();
    const roomId = this.ctx.id.name;
    // Recover old metadata-only operations too, including a crash before work insertion.
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO work SELECT id,0,0 FROM operations WHERE status='pending'",
    );
    if (roomId && this.authority().fence_pending)
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO work VALUES ('fence',0,0)",
      );
    this.work.prune();
    try {
      for (const id of this.work.due()) {
        if (Date.now() - start >= ALARM_BUDGET_MS) break;
        if (id === "fence" && roomId)
          await this.fence(roomId, WorkBudget.remaining(start));
        else if (id === "initialization") await this.endInitialization();
        else if (
          id === "cleanup" &&
          roomId &&
          !this.authority().fence_pending
        ) {
          const response = await this.external(
            "http://adapter/cleanup",
            {
              method: "POST",
              body: JSON.stringify({ roomId }),
            },
            WorkBudget.remaining(start),
          );
          if (response.ok) this.work.done(id);
        } else {
          const row = this.ctx.storage.sql
            .exec<Stored>("SELECT * FROM operations WHERE id=?", id)
            .toArray()[0];
          if (row) {
            const operation = operationSchema.parse(
              JSON.parse(row.metadata) as unknown,
            );
            await this.settle(
              operation,
              Date.now() >= operation.deadline ? "/cancel" : "/status",
              WorkBudget.remaining(start),
            );
          }
        }
        this.work.retry(id);
      }
    } finally {
      await this.work.schedule();
    }
  }
  private initialization() {
    return this.ctx.storage.sql
      .exec<{
        create_id: string;
        checksum: string;
        assets: string;
        deadline: number;
        status: string;
      }>("SELECT * FROM initialization")
      .toArray()[0];
  }
  private async endInitialization(): Promise<void> {
    await this.work.commit(() => {
      this.ctx.storage.sql.exec(
        "UPDATE initialization SET status='ended' WHERE status='initializing'",
      );
      this.ctx.storage.sql.exec(
        "UPDATE authority SET closed=1,writer_revoked=1,epoch=epoch+1,fence_pending=1 WHERE closed=0",
      );
      this.work.done("initialization");
      this.work.add("fence");
      this.work.add("cleanup");
    });
  }
  private denied(operation: Operation): boolean {
    const authority = this.authority();
    return (
      !!authority.closed ||
      (operation.actor === "writer" && !!authority.writer_revoked)
    );
  }
  private async revoke(
    operation: Operation,
    close: boolean,
  ): Promise<Response> {
    this.work.prune();
    const existing = this.ctx.storage.sql
      .exec<{ metadata: string; status: string }>(
        "SELECT metadata,status FROM management WHERE id=?",
        operation.operationId,
      )
      .toArray()[0];
    if (existing) {
      if (existing.metadata !== JSON.stringify(operation))
        return new Response(null, { status: 409 });
      if (existing.status === "enforced")
        return Response.json({ status: "enforced" });
    } else {
      const count = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM management")
        .one().count;
      if (count >= MANAGEMENT_RESULT_LIMIT)
        return new Response(null, { status: 429 });
      await this.work.commit(() => {
        const subject = operation.subject ?? "writer";
        const slots = this.ctx.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM security")
          .one().count;
        const same =
          this.ctx.storage.sql
            .exec("SELECT subject FROM security WHERE subject=?", subject)
            .toArray().length > 0;
        const overflow = !same && slots >= SECURITY_QUEUE_LIMIT;
        this.ctx.storage.sql.exec(
          "UPDATE authority SET writer_revoked=1,epoch=epoch+1,fence_pending=1,closed=max(closed,?)",
          close || overflow ? 1 : 0,
        );
        const epoch = this.authority().epoch;
        if (!overflow)
          this.ctx.storage.sql.exec(
            "INSERT INTO security VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET epoch=excluded.epoch",
            subject,
            epoch,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO management VALUES (?,?,?,'pending')",
          operation.operationId,
          JSON.stringify(operation),
          epoch,
        );
        if (close || overflow) {
          this.ctx.storage.sql.exec("UPDATE initialization SET status='ended'");
          this.work.done("initialization");
          this.work.add("cleanup");
        }
        this.work.add("fence");
      });
    }
    await this.work.schedule();
    const response = await this.fence(operation.roomId);
    if (response.status === 202) this.work.retry("fence");
    await this.work.schedule();
    return response;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const metadata = request.headers.get("x-p0-operation") ?? "";
    if (metadata.length > 2_048) return new Response(null, { status: 400 });
    let input: unknown;
    try {
      input = JSON.parse(metadata || "null") as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success) return new Response(null, { status: 400 });
    const operation = parsed.data;
    if (path === "/ping") return new Response(null, { status: 204 });
    if (operation.roomId !== this.ctx.id.name)
      return new Response(null, { status: 403 });
    if (path === "/revoke" || path === "/close")
      return this.revoke(operation, path === "/close");
    if (path === "/initialize-cancel" && operation.actor === "owner") {
      await this.endInitialization();
      await this.work.schedule();
      return this.fence(operation.roomId);
    }
    const init = this.initialization();
    if (init?.status === "initializing" && Date.now() >= init.deadline) {
      await this.endInitialization();
      await this.work.schedule();
    }
    if (this.denied(operation) && path !== "/status" && path !== "/cancel")
      return new Response(null, { status: 403 });
    if (path === "/create") {
      if (operation.actor !== "owner")
        return new Response(null, { status: 403 });
      if (init)
        return new Response(null, {
          status:
            init.create_id === operation.operationId &&
            init.checksum === operation.checksum &&
            init.assets === JSON.stringify(operation.assetIds ?? [])
              ? 200
              : 409,
        });
      const pending = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM operations WHERE status='pending'",
        )
        .one().count;
      if (pending >= NORMAL_QUEUE_LIMIT)
        return new Response(null, { status: 429 });
      await this.work.commit(() => {
        const deadline = Date.now() + INITIALIZATION_TTL_MS;
        this.ctx.storage.sql.exec(
          "INSERT INTO initialization VALUES (1,?,?,?,?,'initializing')",
          operation.operationId,
          operation.checksum,
          JSON.stringify(operation.assetIds ?? []),
          deadline,
        );
        this.work.add("initialization", deadline);
      });
      await this.work.schedule();
      return Response.json({ status: "initializing" });
    }
    if (
      init?.status === "initializing" &&
      operation.actor !== "owner" &&
      path !== "/status" &&
      path !== "/cancel"
    )
      return new Response(null, { status: 409 });
    if (path === "/initialize-finish") {
      if (
        operation.actor !== "owner" ||
        init?.status !== "initializing" ||
        init.checksum !== operation.checksum ||
        init.assets !== JSON.stringify(operation.assetIds ?? [])
      )
        return new Response(null, { status: 409 });
      const result = await this.settle(operation, "/status");
      if (result.status !== "written")
        return Response.json({ status: "pending" }, { status: 202 });
      const receipt = await this.adapter("/verify-initialization", operation);
      const verified = receipt.ok
        ? await receipt.json<{ verified?: unknown }>()
        : undefined;
      if (verified?.verified !== true)
        return new Response(null, { status: 409 });
      // Recheck after external I/O so cancellation cannot be undone by a late finish.
      if (
        this.denied(operation) ||
        this.initialization()?.status !== "initializing" ||
        Date.now() >= init.deadline
      )
        return new Response(null, { status: 403 });
      this.ctx.storage.sql.exec("UPDATE initialization SET status='ready'");
      this.work.done("initialization");
      await this.work.schedule();
      return Response.json({ status: "ready" });
    }
    if (path === "/asset-finalize" || path === "/asset-index") {
      const response = await this.adapter(path, operation);
      if (this.denied(operation)) return new Response(null, { status: 403 });
      return response;
    }
    if (path === "/socket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (!client || !server) throw new Error("missing-socket");
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/read" || path === "/join") {
      if (this.bodies >= BODY_CONCURRENCY_LIMIT)
        return new Response(null, { status: 429 });
      this.bodies += 1;
      try {
        const response = await this.adapter("/read", operation);
        const bytes = response.ok
          ? await boundedBody(
              new Request("http://body", {
                method: "POST",
                body: response.body,
              }),
            )
          : undefined;
        if (this.denied(operation)) return new Response(null, { status: 403 });
        if (path === "/join") {
          const assets = await this.adapter("/asset-index", operation);
          if (this.denied(operation))
            return new Response(null, { status: 403 });
          if (!assets.ok) return new Response(null, { status: 503 });
          // Read the finalized reference index before declaring the baseline usable.
          await assets.arrayBuffer();
        }
        return new Response(bytes ? new Uint8Array(bytes) : null, {
          status: response.status,
          headers: response.headers,
        });
      } finally {
        this.bodies -= 1;
      }
    }
    const existing = this.ctx.storage.sql
      .exec<Stored>(
        "SELECT * FROM operations WHERE id=?",
        operation.operationId,
      )
      .toArray()[0];
    if (existing && existing.metadata !== JSON.stringify(operation))
      return new Response(null, { status: 409 });
    if (path === "/status" || path === "/cancel") {
      const result = await this.settle(operation, path);
      await this.work.schedule();
      return Response.json(result);
    }
    if (path !== "/write") return new Response(null, { status: 404 });
    if (
      init?.status === "initializing" &&
      (init.checksum !== operation.checksum ||
        init.assets !== JSON.stringify(operation.assetIds ?? []))
    )
      return new Response(null, { status: 409 });
    if (this.bodies >= BODY_CONCURRENCY_LIMIT)
      return new Response(null, { status: 429 });
    this.bodies += 1;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await boundedBody(request);
      } catch {
        return new Response(null, { status: 413 });
      }
      if ((await checksum(bytes)) !== operation.checksum)
        return new Response(null, { status: 400 });
      if (existing?.status !== undefined && existing.status !== "pending")
        return Response.json({
          status: existing.status,
          revision: existing.revision,
        });
      if (
        this.denied(operation) ||
        operation.epoch !== this.authority().epoch ||
        Date.now() >= operation.deadline ||
        operation.deadline > Date.now() + OPERATION_TTL_MS
      )
        return new Response(null, { status: 403 });
      if (!existing) {
        const pending = this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM operations WHERE status='pending'",
          )
          .one().count;
        if (pending >= NORMAL_QUEUE_LIMIT)
          return new Response(null, { status: 429 });
        await this.work.commit(() => {
          this.ctx.storage.sql.exec(
            "INSERT INTO operations VALUES (?,?,'pending',NULL)",
            operation.operationId,
            JSON.stringify(operation),
          );
          this.work.add(operation.operationId, operation.deadline);
        });
      }
      await this.work.schedule();
      const response = await this.adapter("/write", operation, bytes);
      if (!response.ok)
        return Response.json(
          { status: "pending", revision: null },
          { status: 202 },
        );
      const result = resultSchema.parse(await response.json());
      this.record(operation, result);
      await this.work.schedule();
      return Response.json(result);
    } finally {
      this.bodies -= 1;
    }
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (
      this.authority().writer_revoked ||
      this.authority().closed ||
      this.initialization()?.status === "initializing"
    )
      ws.close(4003, "revoked");
    else for (const peer of this.ctx.getWebSockets()) peer.send(message);
  }
}

export default {
  fetch(request: Request, env: P0Env): Promise<Response> {
    let input: unknown;
    try {
      input = JSON.parse(
        request.headers.get("x-p0-operation") ?? "null",
      ) as unknown;
    } catch {
      return Promise.resolve(new Response(null, { status: 400 }));
    }
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success)
      return Promise.resolve(new Response(null, { status: 400 }));
    const operation = parsed.data;
    return env.P0_ROOM.getByName(operation.roomId).fetch(request);
  },
} satisfies ExportedHandler<P0Env>;
