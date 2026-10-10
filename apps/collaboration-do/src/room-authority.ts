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
  type AssetUploadIntent,
  type ContentResult,
  type ManagementResult,
  type RoomCommand,
  type TrustedIdentity,
  type DurableJob,
  type ProjectionEvent,
  type InviteProjectionEvent,
  type RoomAccess,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema, type RoomId } from "@drawstuff/collaboration/protocol";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";

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
  create_operation: string;
  initialization_deadline: number;
  listed_at: number;
  denied: number;
  projection_dirty: number;
  projection_cursor: string | null;
  parent_confirmed: number;
};
/** Who has opened the room (and the owner). Carries no role: roles are computed. */
type MemberRow = {
  subject: string;
  email_key: string;
  lifecycle_version: number;
  last_joined_at: number | null;
};
type InvitationRow = {
  email_key: string;
  display_email: string;
  role: "viewer" | "editor";
};
type Access = { role: RoomRole; access: RoomAccess };

const ROLE_RANK: Record<RoomRole, number> = { viewer: 0, editor: 1, owner: 2 };
const higherRole = (a: RoomRole, b: RoomRole | undefined): RoomRole =>
  b !== undefined && ROLE_RANK[b] > ROLE_RANK[a] ? b : a;
const LINK_RANK: Record<RoomRow["link_role"], number> = {
  none: 0,
  viewer: 1,
  editor: 2,
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
      INSERT INTO authority_schema SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM authority_schema);`);
    if (
      storage.sql
        .exec<{ version: number }>("SELECT version FROM authority_schema")
        .one().version !== 3
    )
      throw new Error("schema-skew");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS authority_room (
      room_id TEXT PRIMARY KEY, owner TEXT NOT NULL, scene_id TEXT, label TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('initializing','ready','ended')),
      link_role TEXT NOT NULL CHECK(link_role IN ('none','viewer','editor')),
      auth_revision INTEGER NOT NULL CHECK(auth_revision>0), authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
      fenced_epoch INTEGER NOT NULL CHECK(fenced_epoch>0),
      create_operation TEXT NOT NULL UNIQUE, initialization_deadline INTEGER NOT NULL, listed_at INTEGER NOT NULL,
      denied INTEGER NOT NULL DEFAULT 0 CHECK(denied IN (0,1)), projection_dirty INTEGER NOT NULL DEFAULT 0 CHECK(projection_dirty IN (0,1)), projection_cursor TEXT,
      parent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(parent_confirmed IN (0,1))
    ); CREATE TABLE IF NOT EXISTS authority_members (
      subject TEXT PRIMARY KEY, email_key TEXT NOT NULL,
      lifecycle_version INTEGER NOT NULL CHECK(lifecycle_version>0), last_joined_at INTEGER
    ); CREATE INDEX IF NOT EXISTS authority_members_email ON authority_members(email_key);
    CREATE TABLE IF NOT EXISTS authority_allowlist (
      email_key TEXT PRIMARY KEY, display_email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS authority_retired_subjects(subject TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0));
    CREATE TABLE IF NOT EXISTS authority_content (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL, deadline INTEGER NOT NULL,
      terminal_at INTEGER
    ); CREATE TABLE IF NOT EXISTS authority_initial_assets (file_id TEXT PRIMARY KEY);`);
    // Tombstones that could not be queued for keys whose rows are already gone.
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS authority_projection_backlog(id TEXT PRIMARY KEY)",
    );
    this.work = new DurableWork(storage, (job) => this.abandon(job));
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

  private retired(subject: string): boolean {
    return (
      this.storage.sql
        .exec(
          "SELECT subject FROM authority_retired_subjects WHERE subject=?",
          subject,
        )
        .toArray().length > 0
    );
  }

  private checkIdentity(identity: TrustedIdentity): void {
    trustedIdentitySchema.parse(identity);
    if (this.retired(identity.subject)) throw new Error("stale-proof");
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

  private invitation(emailKey: string): InvitationRow | undefined {
    return this.storage.sql
      .exec<InvitationRow>(
        "SELECT email_key,display_email,role FROM authority_allowlist WHERE email_key=?",
        emailKey,
      )
      .toArray()[0];
  }

  /**
   * The single access rule (docs/architecture/collaboration-authority.md). Lifecycle state (ended, denied,
   * initializing) is the caller's concern; this answers only who the room's
   * rules admit and why.
   */
  private access(
    room: RoomRow,
    subject: string,
    emailKey: string,
  ): Access | undefined {
    if (room.owner === subject) return { role: "owner", access: "owned" };
    const linkRole = room.link_role === "none" ? undefined : room.link_role;
    const invited = this.invitation(emailKey);
    // An invitation never lowers what general access already grants (D7).
    if (invited)
      return { role: higherRole(invited.role, linkRole), access: "invited" };
    if (linkRole) return { role: linkRole, access: "link" };
    return undefined;
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
    return this.access(room, identity.subject, identity.email)?.role;
  }

  management(identity: TrustedIdentity, cursor = "", emailCursor = "") {
    this.authorizeRequest(identity, {
      v: 1,
      roomId: this.roomId,
      operationId: crypto.randomUUID(),
      deadline: Date.now() + 1_000,
      action: "get-management",
    });
    const room = this.requireRoom();
    const owner = room.owner === identity.subject;
    const rows = owner
      ? this.storage.sql
          .exec<MemberRow>(
            "SELECT * FROM authority_members WHERE subject>? ORDER BY subject LIMIT 51",
            cursor,
          )
          .toArray()
      : [];
    const emails = owner
      ? this.storage.sql
          .exec<InvitationRow & { last_joined_at: number | null }>(
            "SELECT email_key,display_email,role,(SELECT max(last_joined_at) FROM authority_members WHERE authority_members.email_key=authority_allowlist.email_key) AS last_joined_at FROM authority_allowlist WHERE email_key>? ORDER BY email_key LIMIT 51",
            emailCursor,
          )
          .toArray()
      : [];
    return {
      members: rows.slice(0, 50).map((row) => ({
        userId: row.subject,
        email: row.email_key,
        role: this.retired(row.subject)
          ? null
          : (this.access(room, row.subject, row.email_key)?.role ?? null),
        lastJoinedAt: row.last_joined_at,
      })),
      nextCursor: rows.length > 50 ? rows[49]!.subject : null,
      allowlist: emails.slice(0, 50).map((row) => ({
        email: row.display_email,
        role: row.role,
        lastJoinedAt: row.last_joined_at,
      })),
      nextEmailCursor: emails.length > 50 ? emails[49]!.email_key : null,
    };
  }

  query(operationId: string): ManagementResult | undefined {
    const raw = this.work.query<unknown>(operationId);
    return raw === undefined ? undefined : managementResultSchema.parse(raw);
  }

  async apply(input: RoomCommand): Promise<ManagementResult> {
    const command = roomCommandSchema.parse(input);
    if (command.roomId !== this.roomId) throw new Error("wrong-room");
    const request = JSON.stringify(command);
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
        // Rows whose list projection this command changes; projected once the
        // new revision is known.
        const subjects = new Set<string>([command.actor.subject]);
        const emails = new Set<string>();
        if (command.action === "create") {
          if (this.state()) throw new Error("operation-mismatch");
          const now = Date.now();
          this.storage.sql.exec(
            `INSERT INTO authority_room(room_id,owner,scene_id,label,state,link_role,auth_revision,authority_epoch,fenced_epoch,create_operation,initialization_deadline,listed_at)
             VALUES (?,?,?,?,'initializing',?,1,1,1,?,?,?)`,
            this.roomId,
            command.actor.subject,
            command.sceneId,
            command.label,
            command.linkRole,
            command.operationId,
            now + AUTHORITY_LIMITS.initializationTtlMs,
            now,
          );
          this.recordMember(command.actor, null);
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
            // Records who opened the room and when; never a role (§3).
            this.recordMember(command.actor, Date.now());
          } else if (command.action === "leave") {
            if (
              room.owner === command.actor.subject ||
              !this.role(command.actor)
            )
              throw new Error("forbidden");
            this.storage.sql.exec(
              "DELETE FROM authority_allowlist WHERE email_key=?",
              command.actor.email,
            );
            this.storage.sql.exec(
              "DELETE FROM authority_members WHERE subject=?",
              command.actor.subject,
            );
            this.addEmailRows(command.actor.email, subjects, emails);
            needsFence = true;
          } else {
            if (room.owner !== command.actor.subject)
              throw new Error("forbidden");
            switch (command.action) {
              case "set-link-role":
                if (command.linkRole === room.link_role) break;
                this.storage.sql.exec(
                  "UPDATE authority_room SET link_role=?,projection_dirty=1,projection_cursor=NULL",
                  command.linkRole,
                );
                // Closing or narrowing general access must cut off link-only
                // connections and in-flight writes at once.
                needsFence =
                  LINK_RANK[command.linkRole] < LINK_RANK[room.link_role];
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
                // Only a downgrade can take write access away.
                needsFence =
                  this.invitation(key)?.role === "editor" &&
                  command.role === "viewer";
                this.storage.sql.exec(
                  "INSERT INTO authority_allowlist VALUES (?,?,?,?,?) ON CONFLICT(email_key) DO UPDATE SET role=excluded.role,display_email=excluded.display_email",
                  key,
                  command.email,
                  command.role,
                  command.actor.subject,
                  Date.now(),
                );
                this.addEmailRows(key, subjects, emails);
                break;
              }
              case "remove-email": {
                const key = normalizeAccountEmail(command.email);
                // Removal deletes the row; re-inviting restores access (D3).
                this.storage.sql.exec(
                  "DELETE FROM authority_allowlist WHERE email_key=?",
                  key,
                );
                this.addEmailRows(key, subjects, emails);
                needsFence = true;
                break;
              }
              case "complete-initialization":
                if (
                  room.state !== "initializing" ||
                  room.initialization_deadline <= Date.now()
                )
                  throw new Error("initialization-incomplete");
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
        let projectionPending = false;
        for (const subject of subjects)
          projectionPending = this.project(room, subject) || projectionPending;
        for (const email of emails)
          projectionPending =
            this.projectInvite(room, email) || projectionPending;
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

  /** An invitation change touches its invite row and every account opened under that email. */
  private addEmailRows(
    emailKey: string,
    subjects: Set<string>,
    emails: Set<string>,
  ): void {
    emails.add(emailKey);
    for (const row of this.storage.sql
      .exec<{ subject: string }>(
        "SELECT subject FROM authority_members WHERE email_key=?",
        emailKey,
      )
      .toArray())
      subjects.add(row.subject);
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
      // Only the immutable actor of the original command is needed here.
      const original: unknown = JSON.parse(row.request);
      if (!original || typeof original !== "object" || !("actor" in original))
        throw new Error("malformed");
      if (
        trustedIdentitySchema.parse(original.actor).subject !== identity.subject
      )
        throw new Error("forbidden");
      return;
    }
    if (
      (request.action === "get-state" || request.action === "get-management") &&
      room.owner === identity.subject
    )
      return;
    if (
      request.action === "get-state" ||
      request.action === "get-management" ||
      request.action === "join" ||
      request.action === "leave"
    ) {
      if (
        !this.role(
          identity,
          request.action === "get-state" || request.action === "get-management",
        )
      )
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

  private recordMember(
    identity: TrustedIdentity,
    joinedAt: number | null,
  ): void {
    const old = this.member(identity.subject);
    if (old && identity.lifecycleVersion < old.lifecycle_version)
      throw new Error("stale-proof");
    this.storage.sql.exec(
      "INSERT INTO authority_members(subject,email_key,lifecycle_version,last_joined_at) VALUES (?,?,?,?) ON CONFLICT(subject) DO UPDATE SET email_key=excluded.email_key,lifecycle_version=excluded.lifecycle_version,last_joined_at=coalesce(excluded.last_joined_at,last_joined_at)",
      identity.subject,
      identity.email,
      identity.lifecycleVersion,
      joinedAt,
    );
  }

  /**
   * A subject's list row: live while the room is not ended, the account is not
   * retired, it has an opened record (or owns the room), and the rules still
   * admit it — so closing general access drops link visitors' rows (D4).
   */
  private memberEvent(room: RoomRow, subject: string): ProjectionEvent {
    const member = this.member(subject);
    const access =
      member && room.state !== "ended" && !this.retired(subject)
        ? this.access(room, subject, member.email_key)
        : undefined;
    return {
      v: 1,
      roomId: this.roomId,
      subject,
      version: room.auth_revision,
      status: room.state,
      role: access?.role ?? null,
      access: access?.access ?? null,
      tombstone: !access,
      label: room.label,
      sceneId: room.scene_id,
      listedAt: room.listed_at,
    };
  }

  private inviteEvent(room: RoomRow, emailKey: string): InviteProjectionEvent {
    const invited =
      room.state === "ended" ? undefined : this.invitation(emailKey);
    const linkRole = room.link_role === "none" ? undefined : room.link_role;
    return {
      v: 1,
      roomId: this.roomId,
      email: emailKey,
      version: room.auth_revision,
      status: room.state,
      role: invited ? higherRole(invited.role, linkRole) : null,
      tombstone: !invited,
      label: room.label,
      sceneId: room.scene_id,
      listedAt: room.listed_at,
    };
  }

  private project(room: RoomRow, subject: string): boolean {
    const event = this.memberEvent(room, subject);
    return this.enqueueProjection(room, `projection:${subject}`, {
      kind: "projection",
      event,
    });
  }

  private projectInvite(room: RoomRow, emailKey: string): boolean {
    const event = this.inviteEvent(room, emailKey);
    return this.enqueueProjection(room, `invite:${emailKey}`, {
      kind: "invite-projection",
      event,
    });
  }

  private enqueueProjection(
    room: RoomRow,
    id: string,
    job: Extract<DurableJob, { kind: "projection" | "invite-projection" }>,
  ): boolean {
    if (this.work.enqueue(id, job, false, job.event.version)) return true;
    // Safety operations cannot fail merely because the ordinary projection queue is full.
    if (room.authority_epoch > room.fenced_epoch || room.state === "ended") {
      // The row may already be deleted (remove-email, leave), so the repair
      // walk would never see it; remember the key itself.
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO authority_projection_backlog VALUES (?)",
        id,
      );
      this.storage.sql.exec(
        "UPDATE authority_room SET projection_dirty=1,projection_cursor=NULL",
      );
      return true;
    }
    throw new Error("capacity");
  }

  /**
   * Local follow-up when durable work is abandoned after its retry window.
   * The remote outcome stays unknown, so nothing claims it happened; local
   * records only become terminal so they expire instead of pinning capacity.
   */
  private abandon(job: DurableJob): void {
    const now = Date.now();
    if (job.kind === "settle-content") {
      // Not "cancelled": the write may have landed. A client re-reads the
      // snapshot revision before writing again either way.
      this.storage.sql.exec(
        "UPDATE authority_content SET result=?,terminal_at=? WHERE id=? AND terminal_at IS NULL",
        JSON.stringify({ status: "refused" }),
        now,
        job.operation.operationId,
      );
    } else if (job.kind === "fence") {
      // Results waiting on this fence keep their "pending" status but expire.
      for (const row of this.storage.sql
        .exec<{ id: string; result: string }>(
          "SELECT id,result FROM authority_results WHERE terminal_at IS NULL",
        )
        .toArray()) {
        const result = managementResultSchema.parse(
          JSON.parse(row.result) as unknown,
        );
        if (result.authorityEpoch <= job.authorityEpoch)
          this.storage.sql.exec(
            "UPDATE authority_results SET terminal_at=? WHERE id=?",
            now,
            row.id,
          );
      }
    }
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
        const prior = this.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM authority_retired_subjects WHERE subject=?",
            subject,
          )
          .toArray()[0];
        if (prior && prior.version >= version) return;
        this.storage.sql.exec(
          "INSERT INTO authority_retired_subjects VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET version=max(version,excluded.version)",
          subject,
          version,
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
        if (operation.authorityEpoch !== room.authority_epoch)
          throw new Error("epoch-mismatch");
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

  /** The browser cannot know the provider descriptor; bind its entire intent and verified actor before revealing a receipt. */
  assetContent(
    input: AssetUploadIntent,
    actor: TrustedIdentity,
  ): ContentOperation | undefined {
    const row = this.storage.sql
      .exec<{ request: string }>(
        "SELECT request FROM authority_content WHERE id=?",
        input.operationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    const operation = contentOperationSchema.parse(
      JSON.parse(row.request) as unknown,
    );
    const { excalidrawFileId, byteLength, ...intent } = input;
    if (
      JSON.stringify(operation) !==
        JSON.stringify(
          contentOperationSchema.parse({
            ...intent,
            actor,
            asset: operation.asset,
          }),
        ) ||
      operation.asset?.excalidrawFileId !== excalidrawFileId ||
      operation.asset.byteLength !== byteLength
    )
      throw new Error("operation-mismatch");
    return operation;
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
          room.initialization_deadline > Date.now()
        ) {
          // Receipt and local manifest commit together, including recovery after a lost write reply.
          this.insertInitialAsset(intent.asset.excalidrawFileId);
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

  /**
   * Bounded repair of every list row after a room-wide change (general access,
   * end, readiness) or when a safety mutation outran the projection queue.
   * The cursor walks members (`m:<subject>`) and then invitations
   * (`e:<email>`), one alarm batch at a time.
   */
  async repairProjections(): Promise<void> {
    await this.work.commit(
      () => {
        const room = this.state();
        if (!room?.projection_dirty) return;
        const backlog = this.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM authority_projection_backlog ORDER BY id LIMIT ?",
            AUTHORITY_LIMITS.alarmBatch,
          )
          .toArray();
        for (const { id } of backlog) {
          const separator = id.indexOf(":");
          const key = id.slice(separator + 1);
          const accepted = id.startsWith("projection:")
            ? this.work.enqueue(
                id,
                { kind: "projection", event: this.memberEvent(room, key) },
                false,
                room.auth_revision,
              )
            : this.work.enqueue(
                id,
                {
                  kind: "invite-projection",
                  event: this.inviteEvent(room, key),
                },
                false,
                room.auth_revision,
              );
          if (!accepted) return;
          this.storage.sql.exec(
            "DELETE FROM authority_projection_backlog WHERE id=?",
            id,
          );
        }
        if (backlog.length === AUTHORITY_LIMITS.alarmBatch) return;
        const cursor = room.projection_cursor ?? "m:";
        const members = cursor.startsWith("m:");
        const rows = this.storage.sql
          .exec<{ key: string }>(
            members
              ? "SELECT subject AS key FROM authority_members WHERE subject>? ORDER BY subject LIMIT ?"
              : "SELECT email_key AS key FROM authority_allowlist WHERE email_key>? ORDER BY email_key LIMIT ?",
            cursor.slice(2),
            AUTHORITY_LIMITS.alarmBatch,
          )
          .toArray();
        for (const { key } of rows) {
          const accepted = members
            ? this.work.enqueue(
                `projection:${key}`,
                { kind: "projection", event: this.memberEvent(room, key) },
                false,
                room.auth_revision,
              )
            : this.work.enqueue(
                `invite:${key}`,
                {
                  kind: "invite-projection",
                  event: this.inviteEvent(room, key),
                },
                false,
                room.auth_revision,
              );
          if (!accepted) return;
          this.storage.sql.exec(
            "UPDATE authority_room SET projection_cursor=?",
            `${members ? "m" : "e"}:${key}`,
          );
        }
        if (rows.length < AUTHORITY_LIMITS.alarmBatch)
          this.storage.sql.exec(
            members
              ? "UPDATE authority_room SET projection_cursor='e:'"
              : "UPDATE authority_room SET projection_dirty=0,projection_cursor=NULL",
          );
      },
      () => this.nextDeadline(),
    );
  }

  private insertInitialAsset(fileId: string): void {
    const count = this.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM authority_initial_assets WHERE file_id!=?",
        fileId,
      )
      .one().count;
    if (count >= AUTHORITY_LIMITS.initializationAssets)
      throw new Error("capacity");
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO authority_initial_assets VALUES (?)",
      fileId,
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
      room.initialization_deadline <= Date.now() ||
      room.authority_epoch !== result.authorityEpoch
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
      .exec<{ file_id: string }>("SELECT file_id FROM authority_initial_assets")
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
