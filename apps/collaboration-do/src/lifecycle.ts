import { DurableObject } from "cloudflare:workers";
import {
  lifecycleCommandSchema,
  lifecycleObjectName,
  lifecyclePageSchema,
  lifecyclePhaseSchema,
  type LifecycleCommand,
  type DurableJob,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";

import { DurableWork } from "./durable-work.ts";

type LifecycleRow = {
  operation_id: string;
  command: string;
  phase: string;
  version: number | null;
  cursor: string | null;
  revision: number;
};
type RoomProgress = {
  room_id: string;
  action: "end-room" | "revoke-member";
  enforced: number;
};

/** P2 supplies authenticated adapters; the state machine itself never performs a direct cascade. */
export interface LifecycleAdapter {
  freeze(command: LifecycleCommand): Promise<number>;
  list(
    command: LifecycleCommand,
    version: number,
    cursor: string | null,
  ): Promise<unknown>;
  enforce(
    command: LifecycleCommand,
    version: number,
    room: { roomId: string; action: "end-room" | "revoke-member" },
  ): Promise<"pending" | "enforced">;
  delete(command: LifecycleCommand, version: number): Promise<void>;
}

export class LifecycleProgress {
  readonly work: DurableWork;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly objectName: string,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS lifecycle_schema(version INTEGER NOT NULL);
      INSERT INTO lifecycle_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM lifecycle_schema);`);
    if (
      storage.sql
        .exec<{ version: number }>("SELECT version FROM lifecycle_schema")
        .one().version !== 1
    )
      throw new Error("schema-skew");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS lifecycle_progress (
      operation_id TEXT PRIMARY KEY, command TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('freezing','enumerating','enforcing','deleting','completed')),
      version INTEGER CHECK(version>0), cursor TEXT, revision INTEGER NOT NULL DEFAULT 1
    ); CREATE TABLE IF NOT EXISTS lifecycle_rooms (
      room_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('end-room','revoke-member')),
      enforced INTEGER NOT NULL DEFAULT 0 CHECK(enforced IN (0,1))
    );`);
    this.work = new DurableWork(storage);
  }

  query(operationId: string) {
    const row = this.storage.sql
      .exec<LifecycleRow>(
        "SELECT * FROM lifecycle_progress WHERE operation_id=?",
        operationId,
      )
      .toArray()[0];
    return row
      ? {
          operationId: row.operation_id,
          phase: lifecyclePhaseSchema.parse(row.phase),
          version: row.version,
        }
      : undefined;
  }

  async begin(input: LifecycleCommand) {
    const command = lifecycleCommandSchema.parse(input);
    if (lifecycleObjectName(command.target) !== this.objectName)
      throw new Error("wrong-subject");
    const request = JSON.stringify(command);
    await this.work.commit(() => {
      const row = this.storage.sql
        .exec<LifecycleRow>("SELECT * FROM lifecycle_progress")
        .toArray()[0];
      if (row) {
        if (row.operation_id !== command.operationId || row.command !== request)
          throw new Error("operation-mismatch");
        return;
      }
      this.storage.sql.exec(
        "INSERT INTO lifecycle_progress(operation_id,command,phase,version,cursor) VALUES (?,?,'freezing',NULL,NULL)",
        command.operationId,
        request,
      );
      if (!this.work.enqueue("retirement", { kind: "retire", command }, true))
        throw new Error("capacity");
    });
    return this.query(command.operationId);
  }

  private async transition(
    row: LifecycleRow,
    change: () => void,
  ): Promise<void> {
    await this.work.commit(() => {
      const current = this.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM lifecycle_progress WHERE operation_id=?",
          row.operation_id,
        )
        .one();
      if (current.revision !== row.revision) return;
      change();
      this.storage.sql.exec(
        "UPDATE lifecycle_progress SET revision=revision+1 WHERE operation_id=?",
        row.operation_id,
      );
    });
  }

  /** One bounded step; effects are idempotent under the same operationId and lifecycle version. */
  async advance(
    command: LifecycleCommand,
    adapter: LifecycleAdapter,
  ): Promise<boolean> {
    const row = this.storage.sql
      .exec<LifecycleRow>(
        "SELECT * FROM lifecycle_progress WHERE operation_id=?",
        command.operationId,
      )
      .one();
    if (row.command !== JSON.stringify(lifecycleCommandSchema.parse(command)))
      throw new Error("operation-mismatch");
    switch (lifecyclePhaseSchema.parse(row.phase)) {
      case "freezing": {
        const version = await adapter.freeze(command);
        lifecyclePageSchema.shape.version.parse(version);
        await this.transition(row, () =>
          this.storage.sql.exec(
            "UPDATE lifecycle_progress SET version=?,phase='enumerating' WHERE operation_id=? AND phase='freezing'",
            version,
            command.operationId,
          ),
        );
        return false;
      }
      case "enumerating": {
        if (row.version === null) throw new Error("missing-freeze");
        const page = lifecyclePageSchema.parse(
          await adapter.list(command, row.version, row.cursor),
        );
        if (
          page.version !== row.version ||
          (page.cursor !== null && page.cursor === row.cursor)
        )
          throw new Error("invalid-page");
        await this.transition(row, () => {
          for (const room of page.rooms) {
            this.storage.sql.exec(
              "INSERT INTO lifecycle_rooms VALUES (?,?,0) ON CONFLICT(room_id) DO UPDATE SET action=CASE WHEN action='end-room' OR excluded.action='end-room' THEN 'end-room' ELSE 'revoke-member' END",
              room.roomId,
              room.action,
            );
          }
          this.storage.sql.exec(
            "UPDATE lifecycle_progress SET cursor=?,phase='enforcing' WHERE operation_id=?",
            page.cursor,
            command.operationId,
          );
        });
        return false;
      }
      case "enforcing": {
        if (row.version === null) throw new Error("missing-freeze");
        const room = this.storage.sql
          .exec<RoomProgress>(
            "SELECT * FROM lifecycle_rooms WHERE enforced=0 ORDER BY room_id LIMIT 1",
          )
          .toArray()[0];
        if (room) {
          const result = await adapter.enforce(command, row.version, {
            roomId: roomIdSchema.parse(room.room_id),
            action: room.action,
          });
          if (result !== "enforced") throw new Error("enforcement-pending");
          await this.transition(row, () =>
            this.storage.sql.exec(
              "UPDATE lifecycle_rooms SET enforced=1 WHERE room_id=?",
              room.room_id,
            ),
          );
        } else {
          await this.transition(row, () => {
            // Completed page progress can be discarded; the terminal subject fence remains.
            this.storage.sql.exec(
              "DELETE FROM lifecycle_rooms WHERE enforced=1",
            );
            this.storage.sql.exec(
              "UPDATE lifecycle_progress SET phase=? WHERE operation_id=?",
              row.cursor === null ? "deleting" : "enumerating",
              command.operationId,
            );
          });
        }
        return false;
      }
      case "deleting":
        if (row.version === null) throw new Error("missing-freeze");
        await adapter.delete(command, row.version);
        await this.transition(row, () =>
          this.storage.sql.exec(
            "UPDATE lifecycle_progress SET phase='completed' WHERE operation_id=? AND phase='deleting'",
            command.operationId,
          ),
        );
        return true;
      case "completed":
        return true;
    }
  }
}

export class CollaborationLifecycle extends DurableObject<Env> {
  private readonly progress: LifecycleProgress;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.id.name) throw new Error("missing-subject");
    this.progress = new LifecycleProgress(ctx.storage, ctx.id.name);
  }

  // Only available over the service's DO binding. P2 adds the authenticated gateway entry.
  begin(command: LifecycleCommand) {
    return this.progress.begin(command);
  }
  query(operationId: string) {
    return this.progress.query(operationId);
  }
  override async alarm(): Promise<void> {
    await this.progress.work.drain(async (_job: DurableJob) => {
      // No destructive adapter is enabled in the P1 artifact.
      // P2 connects freeze/list/Room enforcement/delete, using advance().
      throw new Error("lifecycle-adapter-unconfigured");
    });
  }
}
