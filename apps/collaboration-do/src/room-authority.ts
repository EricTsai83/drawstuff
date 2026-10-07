import {
  AUTHORITY_LIMITS,
  contentOperationSchema,
  contentResultSchema,
  managementResultSchema,
  normalizeAccountEmail,
  roomCommandSchema,
  type AuthorityRequest,
  trustedIdentitySchema,
  initializationManifestSchema,
  type ContentOperation,
  type ContentResult,
  type ManagementResult,
  type RoomCommand,
  type TrustedIdentity,
  type ProjectionEvent,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";
import {
  roomRoleSchema,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";

import { DurableWork } from "./durable-work.ts";

type RoomRow = {
  room_id: string;
  owner: string;
  scene_id: string | null;
  label: string;
  state: "initializing" | "ready" | "ended";
  link_role: "none" | "editor" | "viewer";
  auth_revision: number;
  authority_epoch: number;
  fenced_epoch: number;
  auth_generation: number;
  create_operation: string;
  initialization_deadline: number;
  listed_at: number;
  key_check: string | null;
  denied: number;
  projection_dirty: number;
  projection_cursor: string | null;
  parent_confirmed: number;
};
type MemberRow = {
  subject: string;
  role: RoomRole;
  revoked: number;
  lifecycle_version: number;
  email_key: string | null;
};

/** Persistent authority primitives. P2 verifies service/proof and registration before invoking these. */
export class RoomAuthority {
  readonly work: DurableWork;
  readonly roomId: RoomId;

  constructor(
    private readonly storage: DurableObjectStorage,
    objectName: string,
  ) {
    this.roomId = roomIdSchema.parse(objectName);
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS authority_schema(version INTEGER NOT NULL);
      INSERT INTO authority_schema SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM authority_schema);`);
    if (
      storage.sql
        .exec<{ version: number }>("SELECT version FROM authority_schema")
        .one().version !== 2
    )
      throw new Error("schema-skew");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS authority_room (
      room_id TEXT PRIMARY KEY, owner TEXT NOT NULL, scene_id TEXT, label TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('initializing','ready','ended')),
      link_role TEXT NOT NULL CHECK(link_role IN ('none','viewer','editor')),
      auth_revision INTEGER NOT NULL CHECK(auth_revision>0), authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
      fenced_epoch INTEGER NOT NULL CHECK(fenced_epoch>0), auth_generation INTEGER NOT NULL CHECK(auth_generation>0),
      create_operation TEXT NOT NULL UNIQUE, initialization_deadline INTEGER NOT NULL, listed_at INTEGER NOT NULL,
      key_check TEXT, denied INTEGER NOT NULL DEFAULT 0 CHECK(denied IN (0,1)), projection_dirty INTEGER NOT NULL DEFAULT 0 CHECK(projection_dirty IN (0,1)), projection_cursor TEXT,
      parent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(parent_confirmed IN (0,1))
    ); CREATE TABLE IF NOT EXISTS authority_members (
      subject TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), lifecycle_version INTEGER NOT NULL CHECK(lifecycle_version>0), email_key TEXT
    ); CREATE TABLE IF NOT EXISTS authority_allowlist (
      email_key TEXT PRIMARY KEY, display_email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1))
    ); CREATE TABLE IF NOT EXISTS authority_retired_subjects(subject TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0));
    CREATE TABLE IF NOT EXISTS authority_content (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL, deadline INTEGER NOT NULL,
      terminal_at INTEGER
    ); CREATE TABLE IF NOT EXISTS authority_initial_assets (
      file_id TEXT PRIMARY KEY, auth_generation INTEGER NOT NULL CHECK(auth_generation>0)
    );`);
    this.work = new DurableWork(storage);
  }

  state(): RoomRow | undefined {
    return this.storage.sql
      .exec<RoomRow>(
        "SELECT * FROM authority_room WHERE room_id=?",
        this.roomId,
      )
      .toArray()[0];
  }

  private requireRoom(): RoomRow {
    const room = this.state();
    if (!room) throw new Error("not-found");
    return room;
  }

  private checkIdentity(identity: TrustedIdentity): void {
    trustedIdentitySchema.parse(identity);
    if (
      this.storage.sql
        .exec(
          "SELECT subject FROM authority_retired_subjects WHERE subject=?",
          identity.subject,
        )
        .toArray().length
    )
      throw new Error("stale-proof");
    const member = this.member(identity.subject);
    if (member && identity.lifecycleVersion < member.lifecycle_version)
      throw new Error("stale-proof");
  }

  private member(subject: string): MemberRow | undefined {
    return this.storage.sql
      .exec<MemberRow>(
        "SELECT * FROM authority_members WHERE subject=?",
        subject,
      )
      .toArray()[0];
  }

  role(
    identity: TrustedIdentity,
    initializingOwner = false,
  ): RoomRole | undefined {
    this.checkIdentity(identity);
    const room = this.requireRoom();
    if (room.denied || room.state === "ended") return undefined;
    if (
      room.state === "initializing" &&
      !(initializingOwner && room.owner === identity.subject)
    )
      return undefined;
    if (room.owner === identity.subject) return "owner";
    const member = this.member(identity.subject);
    if (member)
      return member.revoked ? undefined : roomRoleSchema.parse(member.role);
    if (room.link_role !== "none") return room.link_role;
    const allowed = this.storage.sql
      .exec<{ role: RoomRole; removed: number }>(
        "SELECT role,removed FROM authority_allowlist WHERE email_key=?",
        identity.email,
      )
      .toArray()[0];
    if (allowed)
      return allowed.removed ? undefined : roomRoleSchema.parse(allowed.role);
    return undefined;
  }

  query(operationId: string): ManagementResult | undefined {
    const raw = this.work.query<unknown>(operationId);
    return raw === undefined ? undefined : managementResultSchema.parse(raw);
  }

  async apply(input: RoomCommand): Promise<ManagementResult> {
    const command = roomCommandSchema.parse(input);
    if (command.roomId !== this.roomId) throw new Error("wrong-room");
    // Byte arrays have a canonical metadata representation for immutable operation binding.
    const request = JSON.stringify(command, (_key, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    return this.work.commit(
      () => {
        this.checkIdentity(command.actor);
        const replay = this.work.replay<unknown>(command.operationId, request);
        if (replay !== undefined) return managementResultSchema.parse(replay);
        if (command.deadline <= Date.now())
          throw new Error("expired-operation");
        if (command.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs)
          throw new Error("expired-operation");
        let role: RoomRole | undefined;
        let needsFence = false;
        if (command.action === "create") {
          if (this.state()) throw new Error("operation-mismatch");
          const now = Date.now();
          this.storage.sql.exec(
            "INSERT INTO authority_room VALUES (?,?,?,?, 'initializing',?,1,1,1,1,?,?,?,NULL,0,0,NULL,0)",
            this.roomId,
            command.actor.subject,
            command.sceneId,
            command.label,
            command.linkRole,
            command.operationId,
            now + AUTHORITY_LIMITS.initializationTtlMs,
            now,
          );
          this.upsertMember(
            command.actor.subject,
            "owner",
            command.actor.lifecycleVersion,
            command.actor.email,
          );
          if (
            !this.work.enqueue(
              `parent:${command.operationId}`,
              {
                kind: "create-parent",
                command: {
                  v: 1,
                  action: "create-parent",
                  roomId: this.roomId,
                  owner: command.actor,
                  createOperationId: command.operationId,
                  sceneId: command.sceneId,
                  label: command.label,
                  linkRole: command.linkRole,
                  initializationDeadline:
                    this.requireRoom().initialization_deadline,
                },
              },
              false,
            )
          )
            throw new Error("capacity");
        } else {
          const room = this.requireRoom();
          if (room.state === "ended") throw new Error("ended");
          if (
            room.denied &&
            command.action !== "end-room" &&
            command.action !== "cancel-initialization"
          )
            throw new Error("capacity");
          if (command.action === "join") {
            if (room.state !== "ready") throw new Error("initializing");
            role = this.role(command.actor);
            if (!role) throw new Error("forbidden");
            if (command.registrationVersion !== command.actor.lifecycleVersion)
              throw new Error("stale-proof");
            this.upsertMember(
              command.actor.subject,
              role,
              command.registrationVersion,
              command.actor.email,
            );
          } else {
            if (room.owner !== command.actor.subject)
              throw new Error("forbidden");
            switch (command.action) {
              case "set-link-role":
                this.storage.sql.exec(
                  "UPDATE authority_room SET link_role=?",
                  command.linkRole,
                );
                break;
              case "set-member-role":
                if (command.subject === room.owner)
                  throw new Error("forbidden");
                if (
                  this.storage.sql
                    .exec(
                      "SELECT subject FROM authority_retired_subjects WHERE subject=?",
                      command.subject,
                    )
                    .toArray().length
                )
                  throw new Error("stale-proof");
                this.upsertMember(
                  command.subject,
                  command.role,
                  command.registrationVersion,
                );
                needsFence = true;
                break;
              case "revoke-member":
                if (command.subject === room.owner)
                  throw new Error("forbidden");
                this.storage.sql.exec(
                  "INSERT INTO authority_members VALUES (?,'viewer',1,1,NULL) ON CONFLICT(subject) DO UPDATE SET revoked=1",
                  command.subject,
                );
                needsFence = true;
                break;
              case "allow-email": {
                const key = normalizeAccountEmail(command.email);
                const count = this.storage.sql
                  .exec<{ count: number }>(
                    "SELECT count(*) AS count FROM authority_allowlist WHERE email_key!=?",
                    key,
                  )
                  .one().count;
                if (count >= AUTHORITY_LIMITS.allowlistEntries)
                  throw new Error("capacity");
                this.storage.sql.exec(
                  "INSERT INTO authority_allowlist VALUES (?,?,?,?,?,0) ON CONFLICT(email_key) DO UPDATE SET role=excluded.role,display_email=excluded.display_email,removed=0",
                  key,
                  command.email,
                  command.role,
                  command.actor.subject,
                  Date.now(),
                );
                break;
              }
              case "remove-email": {
                const key = normalizeAccountEmail(command.email);
                // Keep the negative decision of a previously allowed address, within the same entry cap.
                this.storage.sql.exec(
                  "UPDATE authority_allowlist SET removed=1 WHERE email_key=?",
                  key,
                );
                this.storage.sql.exec(
                  "UPDATE authority_members SET revoked=1 WHERE email_key=? AND subject!=?",
                  key,
                  room.owner,
                );
                this.storage.sql.exec(
                  "UPDATE authority_room SET projection_dirty=1,projection_cursor=NULL",
                );
                needsFence = true;
                break;
              }
              case "rotate-generation":
                if (command.expectedGeneration !== room.auth_generation)
                  throw new Error("generation-mismatch");
                this.storage.sql.exec(
                  "UPDATE authority_room SET auth_generation=auth_generation+1,key_check=NULL,state='initializing',initialization_deadline=?",
                  Date.now() + AUTHORITY_LIMITS.initializationTtlMs,
                );
                this.storage.sql.exec("DELETE FROM authority_initial_assets");
                needsFence = true;
                break;
              case "set-key-check":
                if (command.expectedGeneration !== room.auth_generation)
                  throw new Error("generation-mismatch");
                if (
                  room.key_check !== null &&
                  room.key_check !==
                    JSON.stringify(Array.from(command.keyCheck))
                )
                  throw new Error("operation-mismatch");
                this.storage.sql.exec(
                  "UPDATE authority_room SET key_check=?",
                  JSON.stringify(Array.from(command.keyCheck)),
                );
                break;
              case "complete-initialization":
                if (
                  room.state !== "initializing" ||
                  !room.key_check ||
                  room.initialization_deadline <= Date.now()
                )
                  throw new Error("initialization-incomplete");
                if (command.manifest.authGeneration !== room.auth_generation)
                  throw new Error("generation-mismatch");
                if (
                  !this.work.enqueue(
                    `initialize:${command.operationId}`,
                    {
                      kind: "initialize",
                      roomId: this.roomId,
                      operationId: command.operationId,
                      manifest: command.manifest,
                    },
                    false,
                  )
                )
                  throw new Error("capacity");
                break;
              case "cancel-initialization":
                if (room.state !== "initializing")
                  throw new Error("initialization-incomplete");
              // Cancellation shares the terminal room transition and the storage fence.
              case "end-room":
                this.storage.sql.exec(
                  "UPDATE authority_room SET state='ended',projection_dirty=1,projection_cursor=NULL",
                );
                needsFence = true;
                break;
            }
          }
          this.storage.sql.exec(
            "UPDATE authority_room SET auth_revision=auth_revision+1",
          );
        }
        if (needsFence) this.fence();
        const room = this.requireRoom();
        if (room.state === "ended") this.cancelInitializationWork(room);
        const projectionPending = this.project(
          room,
          command.action === "revoke-member" ||
            command.action === "set-member-role"
            ? command.subject
            : command.actor.subject,
        );
        const pending =
          needsFence ||
          command.action === "complete-initialization" ||
          command.action === "create";
        const result: ManagementResult = {
          operationId: command.operationId,
          status: pending ? "pending" : "enforced",
          authRevision: room.auth_revision,
          authorityEpoch: room.authority_epoch,
          projectionPending,
          ...(role ? { role } : {}),
        };
        this.work.result(command.operationId, request, result, !pending);
        return result;
      },
      () => this.nextDeadline(),
    );
  }

  /** Preflight locally before any external registration. Identity alone grants no owner capability. */
  authorizeRequest(identity: TrustedIdentity, request: AuthorityRequest): void {
    this.checkIdentity(identity);
    const room = this.state();
    if (request.action === "create") {
      if (room && room.owner !== identity.subject) throw new Error("forbidden");
      return;
    }
    if (!room) throw new Error("not-found");
    if (request.action === "query") {
      const row = this.storage.sql
        .exec<{ request: string }>(
          "SELECT request FROM authority_results WHERE id=?",
          request.operationId,
        )
        .toArray()[0];
      if (!row) throw new Error("not-found");
      // Serialized key-check bytes are arrays; only the immutable actor is needed here.
      const original: unknown = JSON.parse(row.request);
      if (!original || typeof original !== "object" || !("actor" in original))
        throw new Error("malformed");
      if (
        trustedIdentitySchema.parse(original.actor).subject !== identity.subject
      )
        throw new Error("forbidden");
      return;
    }
    if (request.action === "get-state" && room.owner === identity.subject)
      return;
    if (request.action === "get-state" || request.action === "join") {
      if (!this.role(identity, request.action === "get-state"))
        throw new Error("forbidden");
      return;
    }
    if (room.owner !== identity.subject) throw new Error("forbidden");
  }

  async confirmParent(operationId: string): Promise<void> {
    await this.work.commit(
      () => {
        const room = this.requireRoom();
        if (room.create_operation !== operationId)
          throw new Error("operation-mismatch");
        const result = this.query(operationId);
        if (result?.status !== "pending" || room.state === "ended") return;
        const request = this.storage.sql
          .exec<{ request: string }>(
            "SELECT request FROM authority_results WHERE id=?",
            operationId,
          )
          .one().request;
        this.storage.sql.exec("UPDATE authority_room SET parent_confirmed=1");
        this.work.result(
          operationId,
          request,
          { ...result, status: "enforced" },
          true,
        );
        this.work.done(`parent:${operationId}`, 1);
      },
      () => this.nextDeadline(),
    );
  }

  private upsertMember(
    subject: string,
    role: RoomRole,
    version: number,
    email: string | null = null,
  ): void {
    const old = this.member(subject);
    if (old && version < old.lifecycle_version) throw new Error("stale-proof");
    this.storage.sql.exec(
      "INSERT INTO authority_members VALUES (?,?,0,?,?) ON CONFLICT(subject) DO UPDATE SET role=excluded.role,revoked=0,lifecycle_version=excluded.lifecycle_version,email_key=coalesce(excluded.email_key,email_key)",
      subject,
      role,
      version,
      email,
    );
  }

  private project(room: RoomRow, subject: string): boolean {
    const member = this.member(subject);
    if (!member) return false;
    const event: ProjectionEvent = {
      v: 1,
      roomId: this.roomId,
      subject,
      version: room.auth_revision,
      status: room.state,
      role: member.role,
      tombstone: room.state === "ended" || member.revoked !== 0,
      label: room.label,
      sceneId: room.scene_id,
      listedAt: room.listed_at,
    };
    const accepted = this.work.enqueue(
      `projection:${subject}`,
      { kind: "projection", event },
      false,
      event.version,
    );
    if (!accepted) {
      // Safety operations cannot fail merely because the ordinary projection queue is full.
      if (room.authority_epoch > room.fenced_epoch || room.state === "ended") {
        this.storage.sql.exec(
          "UPDATE authority_room SET projection_dirty=1,projection_cursor=NULL",
        );
        return true;
      }
      throw new Error("capacity");
    }
    return true;
  }

  private fence(): void {
    this.cancelCompletionWork();
    this.storage.sql.exec(
      "UPDATE authority_room SET authority_epoch=authority_epoch+1",
    );
    const room = this.requireRoom();
    const job = {
      kind: "fence" as const,
      roomId: this.roomId,
      authorityEpoch: room.authority_epoch,
    };
    if (!this.work.enqueue("room-fence", job, true, room.authority_epoch)) {
      this.storage.sql.exec("UPDATE authority_room SET denied=1");
      this.work.emergencyFence(job);
    }
  }

  private cancelInitializationWork(room: RoomRow): void {
    this.cancelCompletionWork();
    const created = this.query(room.create_operation);
    if (created?.status === "pending") {
      const request = this.storage.sql
        .exec<{ request: string }>(
          "SELECT request FROM authority_results WHERE id=?",
          room.create_operation,
        )
        .one().request;
      this.work.result(
        room.create_operation,
        request,
        { ...created, status: "cancelled" },
        true,
      );
    }
    this.work.done(`parent:${room.create_operation}`, 1);
    const cleanup = {
      kind: "cleanup" as const,
      roomId: this.roomId,
      operationId: room.create_operation,
    };
    if (!this.work.enqueue(`cleanup:${room.create_operation}`, cleanup, true)) {
      this.storage.sql.exec("UPDATE authority_room SET denied=1");
      this.work.emergencyCleanup(cleanup);
    }
  }

  private cancelCompletionWork(): void {
    const pending = this.storage.sql
      .exec<{ id: string; request: string; result: string }>(
        "SELECT id,request,result FROM authority_results WHERE terminal_at IS NULL",
      )
      .toArray();
    for (const row of pending) {
      const command = roomCommandSchema.safeParse(
        JSON.parse(row.request) as unknown,
      );
      if (command.data?.action !== "complete-initialization") continue;
      const result = managementResultSchema.parse(
        JSON.parse(row.result) as unknown,
      );
      this.work.result(
        row.id,
        row.request,
        { ...result, status: "cancelled" },
        true,
      );
      this.work.done(`initialize:${row.id}`, 1);
    }
  }

  async confirmFence(epoch: number): Promise<void> {
    await this.work.commit(
      () => {
        const room = this.requireRoom();
        if (epoch > room.authority_epoch) throw new Error("invalid-fence");
        this.storage.sql.exec(
          "UPDATE authority_room SET fenced_epoch=max(fenced_epoch,?)",
          epoch,
        );
        const rows = this.storage.sql
          .exec<{ id: string; request: string; result: string }>(
            "SELECT id,request,result FROM authority_results WHERE terminal_at IS NULL",
          )
          .toArray();
        for (const row of rows) {
          const result = managementResultSchema.parse(
            JSON.parse(row.result) as unknown,
          );
          const command = roomCommandSchema.safeParse(
            JSON.parse(row.request) as unknown,
          );
          if (
            result.authorityEpoch > epoch ||
            command.data?.action === "complete-initialization" ||
            command.data?.action === "create"
          )
            continue;
          this.work.result(
            row.id,
            row.request,
            { ...result, status: "enforced" },
            true,
          );
        }
      },
      () => this.nextDeadline(),
    );
  }

  async retireSubject(subject: string, version: number): Promise<void> {
    await this.work.commit(
      () => {
        this.storage.sql.exec(
          "INSERT INTO authority_retired_subjects VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET version=max(version,excluded.version)",
          subject,
          version,
        );
        this.storage.sql.exec(
          "UPDATE authority_members SET revoked=1 WHERE subject=?",
          subject,
        );
        const room = this.state();
        if (!room) return; // Tombstone also protects a delayed create.
        if (room.owner === subject)
          this.storage.sql.exec(
            "UPDATE authority_room SET state='ended',projection_dirty=1,projection_cursor=NULL",
          );
        this.storage.sql.exec(
          "UPDATE authority_room SET auth_revision=auth_revision+1",
        );
        this.fence();
        if (this.requireRoom().state === "ended")
          this.cancelInitializationWork(this.requireRoom());
        this.project(this.requireRoom(), subject);
      },
      () => this.nextDeadline(),
    );
  }

  async acceptContent(input: ContentOperation): Promise<ContentResult> {
    const operation = contentOperationSchema.parse(input);
    const request = JSON.stringify(operation);
    return this.work.commit(
      () => {
        if (operation.roomId !== this.roomId) throw new Error("wrong-room");
        const room = this.requireRoom();
        const role = this.role(operation.actor, true);
        if (
          !role ||
          role === "viewer" ||
          (operation.kind === "snapshot-reset" && role !== "owner")
        )
          throw new Error("forbidden");
        const existing = this.storage.sql
          .exec<{ request: string; result: string }>(
            "SELECT request,result FROM authority_content WHERE id=?",
            operation.operationId,
          )
          .toArray()[0];
        if (existing) {
          if (existing.request !== request)
            throw new Error("operation-mismatch");
          return contentResultSchema.parse(
            JSON.parse(existing.result) as unknown,
          );
        }
        if (
          this.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM authority_content",
            )
            .one().count >= AUTHORITY_LIMITS.managementResults
        )
          throw new Error("capacity");
        if (
          operation.deadline <= Date.now() ||
          operation.deadline > Date.now() + AUTHORITY_LIMITS.operationTtlMs
        )
          throw new Error("expired-operation");
        if (
          operation.authorityEpoch !== room.authority_epoch ||
          operation.authGeneration !== room.auth_generation
        )
          throw new Error("generation-mismatch");
        if (
          !this.work.enqueue(
            `content:${operation.operationId}`,
            { kind: "settle-content", operation },
            false,
            1,
            operation.deadline,
          )
        )
          throw new Error("capacity");
        this.storage.sql.exec(
          "INSERT INTO authority_content VALUES (?,?,?, ?,NULL)",
          operation.operationId,
          request,
          JSON.stringify({ status: "pending" }),
          operation.deadline,
        );
        return { status: "pending" };
      },
      () => this.nextDeadline(),
    );
  }

  contentResult(operationId: string): ContentResult | undefined {
    const row = this.storage.sql
      .exec<{ result: string }>(
        "SELECT result FROM authority_content WHERE id=?",
        operationId,
      )
      .toArray()[0];
    return row
      ? contentResultSchema.parse(JSON.parse(row.result) as unknown)
      : undefined;
  }

  /** Receipt lookups bind the complete immutable intent, even after its deadline. */
  queryContent(input: ContentOperation): ContentResult | undefined {
    const operation = contentOperationSchema.parse(input);
    if (operation.roomId !== this.roomId) throw new Error("wrong-room");
    const row = this.storage.sql
      .exec<{ request: string }>(
        "SELECT request FROM authority_content WHERE id=?",
        operation.operationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.request !== JSON.stringify(operation))
      throw new Error("operation-mismatch");
    return this.contentResult(operation.operationId);
  }

  async settleContent(
    operationId: string,
    input: ContentResult,
  ): Promise<void> {
    const result = contentResultSchema.parse(input);
    if (result.status === "pending") return;
    await this.work.commit(
      () => {
        const old = this.contentResult(operationId);
        if (!old) throw new Error("not-found");
        if (old.status !== "pending") {
          if (JSON.stringify(old) !== JSON.stringify(result))
            throw new Error("operation-mismatch");
          return;
        }
        const operation = this.storage.sql
          .exec<{ request: string }>(
            "SELECT request FROM authority_content WHERE id=?",
            operationId,
          )
          .one();
        const intent = contentOperationSchema.parse(
          JSON.parse(operation.request) as unknown,
        );
        const room = this.requireRoom();
        if (
          result.status === "written" &&
          intent.kind === "asset-finalize" &&
          intent.asset &&
          room.state === "initializing" &&
          !room.denied &&
          room.auth_generation === intent.authGeneration &&
          room.initialization_deadline > Date.now()
        ) {
          // Receipt and local manifest commit together, including recovery after a lost write reply.
          this.insertInitialAsset(
            intent.asset.excalidrawFileId,
            intent.authGeneration,
          );
        }
        this.storage.sql.exec(
          "UPDATE authority_content SET result=?,terminal_at=? WHERE id=?",
          JSON.stringify(result),
          Date.now(),
          operationId,
        );
        this.work.done(`content:${operationId}`, 1);
      },
      () => this.nextDeadline(),
    );
  }

  initializationDeadline(): number | undefined {
    const room = this.state();
    return room?.state === "initializing"
      ? room.initialization_deadline
      : undefined;
  }

  nextDeadline(): number | undefined {
    const retained = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT min(terminal_at)+? AS at FROM authority_content WHERE terminal_at IS NOT NULL",
        AUTHORITY_LIMITS.resultRetentionMs,
      )
      .one().at;
    const room = this.state();
    const at = Math.min(
      this.initializationDeadline() ?? Infinity,
      retained ?? Infinity,
      room?.projection_dirty ? Date.now() + 1_000 : Infinity,
    );
    return Number.isFinite(at) ? at : undefined;
  }

  /** Bounded repair when a safety mutation outruns the ordinary projection queue. */
  async repairProjections(): Promise<void> {
    await this.work.commit(
      () => {
        const room = this.state();
        if (!room?.projection_dirty) return;
        const members = this.storage.sql
          .exec<MemberRow>(
            "SELECT * FROM authority_members WHERE subject>? ORDER BY subject LIMIT ?",
            room.projection_cursor ?? "",
            AUTHORITY_LIMITS.alarmBatch,
          )
          .toArray();
        for (const member of members) {
          const event: ProjectionEvent = {
            v: 1,
            roomId: this.roomId,
            subject: member.subject,
            version: room.auth_revision,
            status: room.state,
            role: member.role,
            tombstone: member.revoked !== 0 || room.state === "ended",
            label: room.label,
            sceneId: room.scene_id,
            listedAt: room.listed_at,
          };
          if (
            !this.work.enqueue(
              `projection:${member.subject}`,
              { kind: "projection", event },
              false,
              event.version,
            )
          )
            return;
          this.storage.sql.exec(
            "UPDATE authority_room SET projection_cursor=?",
            member.subject,
          );
        }
        if (members.length < AUTHORITY_LIMITS.alarmBatch)
          this.storage.sql.exec(
            "UPDATE authority_room SET projection_dirty=0,projection_cursor=NULL",
          );
      },
      () => this.nextDeadline(),
    );
  }

  async recordInitialAsset(fileId: string, generation: number): Promise<void> {
    initializationManifestSchema.shape.assetIds.element.parse(fileId);
    await this.work.commit(
      () => {
        const room = this.requireRoom();
        if (
          room.state !== "initializing" ||
          room.initialization_deadline <= Date.now() ||
          room.denied ||
          generation !== room.auth_generation
        )
          throw new Error("ended");
        this.insertInitialAsset(fileId, generation);
      },
      () => this.nextDeadline(),
    );
  }

  private insertInitialAsset(fileId: string, generation: number): void {
    const count = this.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM authority_initial_assets WHERE file_id!=?",
        fileId,
      )
      .one().count;
    if (count >= AUTHORITY_LIMITS.initializationAssets)
      throw new Error("capacity");
    this.storage.sql.exec(
      "INSERT INTO authority_initial_assets VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET auth_generation=excluded.auth_generation",
      fileId,
      generation,
    );
  }

  /** Pure local check, repeated after each external initialization response. */
  canConfirmInitialization(
    operationId: string,
    confirmation: unknown,
  ): boolean {
    const manifest = initializationManifestSchema.parse(confirmation);
    const result = this.query(operationId);
    const room = this.state();
    if (
      !room ||
      result?.status !== "pending" ||
      !room.parent_confirmed ||
      room.state !== "initializing" ||
      room.denied ||
      !room.key_check ||
      room.initialization_deadline <= Date.now() ||
      room.authority_epoch !== result.authorityEpoch ||
      room.auth_generation !== manifest.authGeneration
    )
      return false;
    const row = this.storage.sql
      .exec<{ request: string }>(
        "SELECT request FROM authority_results WHERE id=?",
        operationId,
      )
      .one();
    const command = roomCommandSchema.parse(JSON.parse(row.request) as unknown);
    if (
      command.action !== "complete-initialization" ||
      JSON.stringify(command.manifest) !== JSON.stringify(manifest)
    )
      throw new Error("operation-mismatch");
    const assets = this.storage.sql
      .exec<{ file_id: string }>(
        "SELECT file_id FROM authority_initial_assets WHERE auth_generation=?",
        manifest.authGeneration,
      )
      .toArray();
    return manifest.assetIds.every((id) =>
      assets.some((asset) => asset.file_id === id),
    );
  }

  /** Called only after the adapter verifies the latest snapshot and complete manifest under its fence. */
  async confirmInitialization(
    operationId: string,
    confirmation: unknown,
  ): Promise<void> {
    const manifest = initializationManifestSchema.parse(confirmation);
    await this.work.commit(
      () => {
        const row = this.storage.sql
          .exec<{ request: string; result: string }>(
            "SELECT request,result FROM authority_results WHERE id=?",
            operationId,
          )
          .one();
        const command = roomCommandSchema.parse(
          JSON.parse(row.request) as unknown,
        );
        const result = managementResultSchema.parse(
          JSON.parse(row.result) as unknown,
        );
        if (
          command.action !== "complete-initialization" ||
          JSON.stringify(command.manifest) !== JSON.stringify(manifest)
        )
          throw new Error("operation-mismatch");
        if (result.status === "enforced") return;
        if (!this.canConfirmInitialization(operationId, manifest))
          throw new Error("initialization-incomplete");
        this.storage.sql.exec(
          "UPDATE authority_room SET state='ready',auth_revision=auth_revision+1,projection_dirty=1,projection_cursor=NULL",
        );
        this.work.result(
          operationId,
          row.request,
          {
            ...result,
            status: "enforced",
            authRevision: this.requireRoom().auth_revision,
            projectionPending: true,
          },
          true,
        );
        this.work.done(`initialize:${operationId}`, 1);
        // Competing completion requests cannot keep stale initialization work alive after readiness.
        this.cancelCompletionWork();
      },
      () => this.nextDeadline(),
    );
  }

  async expireInitialization(): Promise<void> {
    await this.work.commit(
      () => {
        this.storage.sql.exec(
          "DELETE FROM authority_content WHERE terminal_at IS NOT NULL AND terminal_at<=?",
          Date.now() - AUTHORITY_LIMITS.resultRetentionMs,
        );
        const room = this.state();
        if (
          room?.state !== "initializing" ||
          room.initialization_deadline > Date.now()
        )
          return;
        this.storage.sql.exec(
          "UPDATE authority_room SET state='ended',auth_revision=auth_revision+1,projection_dirty=1,projection_cursor=NULL",
        );
        this.fence();
        this.cancelInitializationWork(this.requireRoom());
        this.project(this.requireRoom(), room.owner);
      },
      () => this.nextDeadline(),
    );
  }
}
