import {
  env,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_LIMITS,
  durableJobSchema,
  type InviteProjectionEvent,
  type ProjectionEvent,
  type RoomCommand,
  type TrustedIdentity,
  type LifecycleCommand,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { RoomAuthority } from "../src/room-authority.ts";
import { LifecycleProgress, type LifecycleAdapter } from "../src/lifecycle.ts";
import { userTables } from "./support/room-socket.ts";

const owner: TrustedIdentity = {
  subject: "owner",
  email: "owner@example.com",
  lifecycleVersion: 1,
};
const guest: TrustedIdentity = {
  subject: "guest",
  email: "guest@example.com",
  lifecycleVersion: 1,
};
function fixture() {
  const roomId = roomIdSchema.parse(`foundation-${crypto.randomUUID()}`);
  const stub = env.COLLABORATION_ROOM.getByName(roomId);
  const command = (action: RoomCommand["action"]) => ({
    v: 1 as const,
    operationId: crypto.randomUUID(),
    roomId,
    actor: owner,
    deadline: Date.now() + 50_000,
    action,
  });
  return { roomId, stub, command };
}

type Envelope = "v" | "operationId" | "roomId" | "deadline" | "actor";
/** One command minus its envelope; the actor defaults to the owner. */
type CommandBody = RoomCommand extends infer C
  ? C extends RoomCommand
    ? Omit<C, Envelope> & { actor?: TrustedIdentity }
    : never
  : never;

function send(a: RoomAuthority, body: CommandBody) {
  // The spread of a union body is re-validated by `apply`'s own schema.
  return a.apply({
    v: 1,
    operationId: crypto.randomUUID(),
    roomId: a.roomId,
    deadline: Date.now() + 50_000,
    actor: owner,
    ...body,
  } as RoomCommand);
}

const join = (a: RoomAuthority, actor: TrustedIdentity) =>
  send(a, {
    action: "join",
    actor,
    registrationVersion: actor.lifecycleVersion,
  });

/** A ready room owned by `owner`, seeded directly through Room authority. */
async function readyAuthority(
  state: DurableObjectState,
  roomId: string,
  linkRole: "none" | "viewer" | "editor",
): Promise<RoomAuthority> {
  const a = new RoomAuthority(state.storage, roomId);
  const create = await send(a, {
    action: "create",
    sceneId: null,
    label: "",
    linkRole,
  });
  await a.confirmParent(create.operationId);
  state.storage.sql.exec("UPDATE authority_room SET state='ready'");
  return a;
}

/**
 * Latest queued list projections, keyed by subject and by email. Delivery is
 * not configured on these Objects (no adapter URL), so queued jobs stay put.
 */
function queuedProjections(state: DurableObjectState) {
  const members = new Map<string, ProjectionEvent>();
  const invites = new Map<string, InviteProjectionEvent>();
  for (const row of state.storage.sql
    .exec<{ body: string }>(
      "SELECT body FROM authority_work WHERE id LIKE 'projection:%' OR id LIKE 'invite:%'",
    )
    .toArray()) {
    const job = durableJobSchema.parse(JSON.parse(row.body) as unknown);
    if (job.kind === "projection") members.set(job.event.subject, job.event);
    if (job.kind === "invite-projection")
      invites.set(job.event.email, job.event);
  }
  return { members, invites };
}

function memberRow(state: DurableObjectState, subject: string) {
  return state.storage.sql
    .exec("SELECT * FROM authority_members WHERE subject=?", subject)
    .toArray()[0];
}

describe("persistent Room authority foundation", () => {
  it("bounds management pages independently and hides owner-only metadata", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const authority = await readyAuthority(state, roomId, "editor");
      for (let index = 0; index < 51; index++) {
        const email = `invited-${String(index).padStart(2, "0")}@example.com`;
        await authority.apply({
          ...command("allow-email"),
          action: "allow-email",
          email,
          role: "viewer",
        });
        await authority.apply({
          ...command("join"),
          action: "join",
          actor: {
            subject: `member-${String(index).padStart(2, "0")}`,
            email,
            lifecycleVersion: 1,
          },
          registrationVersion: 1,
        });
      }
      const first = authority.management(owner);
      expect(first.members).toHaveLength(50);
      expect(first.allowlist).toHaveLength(50);
      expect(
        first.members.every((member) => member.lastJoinedAt !== null),
      ).toBe(true);
      expect(
        first.allowlist.every((entry) => entry.lastJoinedAt !== null),
      ).toBe(true);
      const second = authority.management(
        owner,
        first.nextCursor!,
        first.nextEmailCursor!,
      );
      expect(second.members).toHaveLength(2);
      expect(second.allowlist).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(second.nextEmailCursor).toBeNull();
      expect(
        authority.management({
          subject: "member-00",
          email: "invited-00@example.com",
          lifecycleVersion: 1,
        }),
      ).toMatchObject({ members: [], allowlist: [] });
    });
  });

  it("deduplicates create across eviction and rejects a changed intent", async () => {
    const { roomId, stub, command } = fixture();
    const create = {
      ...command("create"),
      action: "create" as const,
      sceneId: null,
      label: "Independent",
      linkRole: "editor" as const,
    };
    const first = await runInDurableObject(stub, async (_instance, state) =>
      new RoomAuthority(state.storage, roomId).apply(create),
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const authority = new RoomAuthority(state.storage, roomId);
      expect(await authority.apply(create)).toEqual(first);
      expect(authority.state()).toMatchObject({
        state: "initializing",
        scene_id: null,
        owner: "owner",
      });
      await expect(
        authority.apply({ ...create, label: "changed" }),
      ).rejects.toThrow("operation-mismatch");
      await expect(
        authority.apply({
          ...command("join"),
          action: "join",
          actor: guest,
          registrationVersion: 1,
        }),
      ).rejects.toThrow("initializing");
    });
  });

  it("requires a confirmed parent before readiness and keeps removal enforced across eviction", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const complete = {
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: { revision: 1, checksum: "a".repeat(64), assetIds: [] },
      };
      expect((await a.apply(complete)).status).toBe("pending");
      await expect(
        a.confirmInitialization(complete.operationId, complete.manifest),
      ).rejects.toThrow("initialization-incomplete");
      await a.confirmParent(a.state()!.create_operation);
      await a.confirmInitialization(complete.operationId, complete.manifest);
      expect(a.state()?.state).toBe("ready");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      await join(a, guest);
      expect(a.role(guest)).toBe("editor");
      const removed = await send(a, {
        action: "remove-email",
        email: guest.email,
      });
      expect(removed.status).toBe("pending");
      expect(a.role(guest)).toBeUndefined();
      await a.confirmFence(removed.authorityEpoch);
      expect(a.query(removed.operationId)?.status).toBe("enforced");
      const createOperation = a.state()!.create_operation;
      await a.work.commit(() => {
        state.storage.sql.exec(
          "UPDATE authority_results SET terminal_at=0 WHERE id=?",
          createOperation,
        );
        a.work.prune();
      });
      expect(a.query(createOperation)).toBeUndefined();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      expect(a.role(guest)).toBeUndefined();
      expect(a.state()).toMatchObject({ state: "ready", parent_confirmed: 1 });
    });
  });

  it("accepts safety work with a full normal queue and fails closed when reserve is exhausted", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "editor",
      });
      for (let i = 1; i < AUTHORITY_LIMITS.normalJobs; i++)
        a.work.enqueue(
          `normal:${i}`,
          { kind: "cleanup", roomId, operationId: crypto.randomUUID() },
          false,
        );
      for (let i = 0; i < AUTHORITY_LIMITS.securityJobs; i++)
        a.work.enqueue(
          `security:${i}`,
          { kind: "fence", roomId, authorityEpoch: 1 },
          true,
        );
      const result = await a.apply({
        ...command("remove-email"),
        action: "remove-email",
        email: guest.email,
      });
      expect(result.status).toBe("pending");
      expect(a.state()?.denied).toBe(1);
      expect(a.state()?.projection_dirty).toBe(1);
      expect(a.role(owner, true)).toBeUndefined();
      expect(
        state.storage.sql
          .exec("SELECT * FROM authority_work WHERE id='emergency-fence'")
          .toArray(),
      ).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await a.apply({ ...command("end-room"), action: "end-room" });
      expect(a.state()?.state).toBe("ended");
      expect(
        state.storage.sql
          .exec("SELECT * FROM authority_work WHERE id='emergency-cleanup'")
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("rolls back business state and work together when the local transaction fails", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await expect(
        a.work.commit(() => {
          state.storage.sql.exec(
            "INSERT INTO authority_retired_subjects VALUES ('guest',2)",
          );
          a.work.enqueue(
            "failed",
            { kind: "fence", roomId, authorityEpoch: 2 },
            true,
          );
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        state.storage.sql
          .exec("SELECT * FROM authority_retired_subjects")
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM authority_work").toArray(),
      ).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("protects a retired subject even when its create proof arrives late", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.retireSubject(owner.subject, 2);
      await expect(
        a.apply({
          ...command("create"),
          action: "create",
          sceneId: null,
          label: "",
          linkRole: "none",
        }),
      ).rejects.toThrow("stale-proof");
      expect(a.state()).toBeUndefined();
    });
  });

  it("retains content result after response loss and rejects reuse of the operationId", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const metadata = {
        v: 1 as const,
        operationId: crypto.randomUUID(),
        roomId,
        actor: owner,
        deadline: Date.now() + 50_000,
        kind: "snapshot-put" as const,
        authorityEpoch: 1,
        expectedRevision: 0,
        checksum: "b".repeat(64),
      };
      expect(await a.acceptContent(metadata)).toEqual({ status: "pending" });
      await a.settleContent(metadata.operationId, {
        status: "written",
        revision: 1,
      });
      expect(await a.acceptContent(metadata)).toEqual({
        status: "written",
        revision: 1,
      });
      await expect(
        a.acceptContent({ ...metadata, checksum: "c".repeat(64) }),
      ).rejects.toThrow("operation-mismatch");
      await expect(
        a.settleContent(metadata.operationId, { status: "cancelled" }),
      ).rejects.toThrow("operation-mismatch");
      await expect(
        a.acceptContent({
          ...metadata,
          operationId: crypto.randomUUID(),
          authorityEpoch: 2,
        }),
      ).rejects.toThrow("epoch-mismatch");
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(authority_content)")
        .toArray()
        .map((row) => row.name);
      expect(columns).not.toContain("ciphertext");
    });
  });

  it("does not acknowledge a new fence with an older in-flight response", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.work.commit(() =>
        a.work.enqueue(
          "fence",
          { kind: "fence", roomId, authorityEpoch: 1 },
          true,
          1,
        ),
      );
      await a.work.drain(async () => {
        await a.work.commit(() =>
          a.work.enqueue(
            "fence",
            { kind: "fence", roomId, authorityEpoch: 2 },
            true,
            2,
          ),
        );
      });
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM authority_work WHERE id='fence'",
          )
          .one().version,
      ).toBe(2);
    });
  });

  it("ends expired initialization, cancels completion work and refuses late content", async () => {
    const { roomId, stub, command } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.apply({
        ...command("create"),
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const complete = {
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: { revision: 1, checksum: "a".repeat(64), assetIds: [] },
      };
      await a.apply(complete);
      state.storage.sql.exec(
        "UPDATE authority_room SET initialization_deadline=?",
        Date.now() - 1,
      );
      await a.expireInitialization();
      expect(a.state()?.state).toBe("ended");
      expect(a.query(complete.operationId)?.status).toBe("cancelled");
      await expect(
        a.confirmInitialization(complete.operationId, complete.manifest),
      ).rejects.toThrow("initialization-incomplete");
      await expect(
        a.acceptContent({
          v: 1,
          operationId: crypto.randomUUID(),
          roomId,
          actor: owner,
          deadline: Date.now() + 50_000,
          kind: "snapshot-put",
          authorityEpoch: a.state()!.authority_epoch,
          expectedRevision: 0,
          checksum: "c".repeat(64),
        }),
      ).rejects.toThrow("forbidden");
      const jobs = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM authority_work")
        .toArray();
      expect(jobs.some((row) => row.body.includes('"kind":"cleanup"'))).toBe(
        true,
      );
    });
  });

  it("bounds alarm batches and keeps pending results when terminal retention expires", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await a.work.commit(() => {
        for (let i = 0; i < 32; i++)
          a.work.enqueue(
            `cleanup:${i}`,
            { kind: "cleanup", roomId, operationId: crypto.randomUUID() },
            false,
          );
        a.work.result("pending", "{}", { status: "pending" }, false);
        a.work.result("terminal", "{}", { status: "enforced" }, true);
        state.storage.sql.exec(
          "UPDATE authority_results SET terminal_at=0 WHERE id='terminal'",
        );
      });
      let delivered = 0;
      await a.work.drain(async () => {
        delivered++;
      });
      expect(delivered).toBe(AUTHORITY_LIMITS.alarmBatch);
      expect(a.work.query("pending")).toEqual({ status: "pending" });
      expect(a.work.query("terminal")).toBeUndefined();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM authority_work",
          )
          .one().count,
      ).toBe(16);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

/** Plan 21 §3: one access rule, computed on every check, never frozen at join. */
describe("Room access rule", () => {
  it("admits only the owner while initializing and nobody once ended", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await send(a, {
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "editor",
      });
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(a.role(owner)).toBeUndefined();
      expect(a.role(owner, true)).toBe("owner");
      expect(a.role(guest, true)).toBeUndefined();
      state.storage.sql.exec("UPDATE authority_room SET state='ready'");
      expect(a.role(owner)).toBe("owner");
      expect(a.role(guest)).toBe("editor");
      await send(a, { action: "end-room" });
      expect(a.role(owner, true)).toBeUndefined();
      expect(a.role(guest)).toBeUndefined();
    });
  });

  it("with general access off, refuses uninvited accounts and admits invitees with their invited role", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      expect(a.role(guest)).toBeUndefined();
      await expect(join(a, guest)).rejects.toThrow("forbidden");
      expect(memberRow(state, guest.subject)).toBeUndefined();
      // Invitations match the normalized account email.
      await send(a, {
        action: "allow-email",
        email: "  Guest@Example.com ",
        role: "viewer",
      });
      expect((await join(a, guest)).role).toBe("viewer");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(a.role(guest)).toBe("editor");
    });
  });

  it("takes the higher of invitation and general access (D7)", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(a.role(guest)).toBe("editor");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "viewer",
      });
      await send(a, { action: "set-link-role", linkRole: "editor" });
      expect(a.role(guest)).toBe("editor");
      await join(a, guest);
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { role: "editor", access: "invited", tombstone: false },
      );
      expect(queuedProjections(state).invites.get(guest.email)).toMatchObject({
        role: "editor",
        tombstone: false,
      });
    });
  });

  it("admits link visitors with the link role and drops them when general access closes", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      expect((await join(a, guest)).role).toBe("viewer");
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { role: "viewer", access: "link", tombstone: false },
      );
      // Widening needs no fence; narrowing does.
      expect(
        (await send(a, { action: "set-link-role", linkRole: "editor" })).status,
      ).toBe("enforced");
      expect(a.role(guest)).toBe("editor");
      const closed = await send(a, {
        action: "set-link-role",
        linkRole: "none",
      });
      expect(closed.status).toBe("pending");
      expect(a.state()?.authority_epoch).toBe(closed.authorityEpoch);
      expect(a.role(guest)).toBeUndefined();
      await expect(join(a, guest)).rejects.toThrow("forbidden");
      // Room-wide changes reach every row through the repair walk.
      expect(a.state()?.projection_dirty).toBe(1);
      while (a.state()?.projection_dirty) await a.repairProjections();
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        {
          version: closed.authRevision,
          role: null,
          access: null,
          tombstone: true,
        },
      );
      expect(queuedProjections(state).members.get(owner.subject)).toMatchObject(
        { role: "owner", access: "owned", tombstone: false },
      );
    });
  });

  it("records who opened the room without freezing a role at join", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "viewer",
      });
      expect((await join(a, guest)).role).toBe("viewer");
      expect(
        state.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(authority_members)")
          .toArray()
          .map((column) => column.name),
      ).toEqual([
        "subject",
        "email_key",
        "lifecycle_version",
        "last_joined_at",
      ]);
      expect(memberRow(state, guest.subject)).toMatchObject({
        email_key: guest.email,
        lifecycle_version: 1,
      });
      // An upgrade only widens access: enforced without a fence.
      const upgraded = await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(upgraded.status).toBe("enforced");
      expect(a.role(guest)).toBe("editor");
      // A downgrade can take write access away, so it fences.
      const downgraded = await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "viewer",
      });
      expect(downgraded.status).toBe("pending");
      expect(a.role(guest)).toBe("viewer");
    });
  });

  it("removing an invitation deletes it, tombstones its rows, and falls back to general access", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      await join(a, guest);
      const removed = await send(a, {
        action: "remove-email",
        email: guest.email,
      });
      expect(removed.status).toBe("pending");
      expect(a.role(guest)).toBeUndefined();
      expect(
        state.storage.sql.exec("SELECT * FROM authority_allowlist").toArray(),
      ).toEqual([]);
      const afterRemoval = queuedProjections(state);
      expect(afterRemoval.invites.get(guest.email)).toMatchObject({
        version: removed.authRevision,
        role: null,
        tombstone: true,
      });
      expect(afterRemoval.members.get(guest.subject)).toMatchObject({
        version: removed.authRevision,
        role: null,
        access: null,
        tombstone: true,
      });
      // The opened record stays for the list; it grants nothing by itself.
      expect(memberRow(state, guest.subject)).toBeDefined();
      expect(
        a.management(owner).members.find((m) => m.userId === guest.subject),
      ).toMatchObject({ role: null });

      await send(a, { action: "set-link-role", linkRole: "viewer" });
      expect((await join(a, guest)).role).toBe("viewer");
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { role: "viewer", access: "link" },
      );

      // Re-inviting restores invited access (D3).
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(a.role(guest)).toBe("editor");
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { role: "editor", access: "invited" },
      );
      expect(queuedProjections(state).invites.get(guest.email)).toMatchObject({
        role: "editor",
        tombstone: false,
      });
    });
  });

  it("orders projections by revision and never lets an older event overwrite a newer one", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      const invited = await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "viewer",
      });
      const stale = queuedProjections(state).invites.get(guest.email)!;
      expect(stale.version).toBe(invited.authRevision);
      const removed = await send(a, {
        action: "remove-email",
        email: guest.email,
      });
      expect(removed.authRevision).toBeGreaterThan(invited.authRevision);
      expect(
        a.work.enqueue(
          `invite:${guest.email}`,
          { kind: "invite-projection", event: stale },
          false,
          stale.version,
        ),
      ).toBe(true);
      expect(queuedProjections(state).invites.get(guest.email)).toMatchObject({
        version: removed.authRevision,
        tombstone: true,
      });
    });
  });

  it("leave deletes the invitation and opened record and tombstones both rows; the owner cannot leave", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      await join(a, guest);
      await expect(send(a, { action: "leave" })).rejects.toThrow("forbidden");
      const left = await send(a, { action: "leave", actor: guest });
      expect(left.status).toBe("pending");
      expect(a.role(guest)).toBeUndefined();
      expect(memberRow(state, guest.subject)).toBeUndefined();
      expect(
        state.storage.sql.exec("SELECT * FROM authority_allowlist").toArray(),
      ).toEqual([]);
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { tombstone: true, role: null, access: null },
      );
      expect(queuedProjections(state).invites.get(guest.email)).toMatchObject({
        tombstone: true,
        role: null,
      });
      // Without access there is nothing left to leave.
      await expect(send(a, { action: "leave", actor: guest })).rejects.toThrow(
        "forbidden",
      );
    });
  });

  it("a link visitor's leave only drops its row; the link still admits it", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      await join(a, guest);
      await send(a, { action: "leave", actor: guest });
      expect(memberRow(state, guest.subject)).toBeUndefined();
      expect(queuedProjections(state).members.get(guest.subject)).toMatchObject(
        { tombstone: true },
      );
      expect(a.role(guest)).toBe("viewer");
    });
  });

  it("end-room tombstones every member and invitation row through repair", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      const invitee = "pending-invitee@example.com";
      await send(a, { action: "allow-email", email: invitee, role: "editor" });
      await join(a, guest);
      const ended = await send(a, { action: "end-room" });
      expect(ended.status).toBe("pending");
      while (a.state()?.projection_dirty) await a.repairProjections();
      const { members, invites } = queuedProjections(state);
      for (const subject of [owner.subject, guest.subject])
        expect(members.get(subject)).toMatchObject({
          version: ended.authRevision,
          status: "ended",
          tombstone: true,
        });
      expect(invites.get(invitee)).toMatchObject({
        version: ended.authRevision,
        status: "ended",
        tombstone: true,
      });
      await expect(
        send(a, { action: "allow-email", email: invitee, role: "viewer" }),
      ).rejects.toThrow("ended");
    });
  });

  it("repairs projections in bounded batches, members first and then invitations", async () => {
    const { roomId, stub } = fixture();
    const count = AUTHORITY_LIMITS.alarmBatch + 4;
    const pad = (index: number) => String(index).padStart(2, "0");
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      for (let index = 0; index < count; index++) {
        await join(a, {
          subject: `visitor-${pad(index)}`,
          email: `visitor-${pad(index)}@example.com`,
          lifecycleVersion: 1,
        });
        await send(a, {
          action: "allow-email",
          email: `invitee-${pad(index)}@example.com`,
          role: "editor",
        });
      }
      const closed = await send(a, {
        action: "set-link-role",
        linkRole: "none",
      });
      const cursors: (string | null)[] = [];
      while (a.state()?.projection_dirty) {
        await a.repairProjections();
        cursors.push(a.state()!.projection_cursor);
      }
      // Members sort as owner < visitor-*; the walk ends each table on a short page.
      expect(cursors).toEqual([
        `m:visitor-${pad(AUTHORITY_LIMITS.alarmBatch - 2)}`,
        "e:",
        `e:invitee-${pad(AUTHORITY_LIMITS.alarmBatch - 1)}@example.com`,
        null,
      ]);
      const { members, invites } = queuedProjections(state);
      for (let index = 0; index < count; index++) {
        expect(members.get(`visitor-${pad(index)}`)).toMatchObject({
          version: closed.authRevision,
          tombstone: true,
        });
        expect(invites.get(`invitee-${pad(index)}@example.com`)).toMatchObject({
          version: closed.authRevision,
          role: "editor",
          tombstone: false,
        });
      }
    });
  });

  it("shows owners every opener with their current role and the plain invitation list", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "viewer");
      const visitor = {
        subject: "visitor",
        email: "visitor@example.com",
        lifecycleVersion: 1,
      };
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      await join(a, guest);
      await join(a, visitor);
      await send(a, { action: "set-link-role", linkRole: "none" });
      const view = a.management(owner);
      expect(view.members).toEqual([
        {
          userId: guest.subject,
          email: guest.email,
          role: "editor",
          lastJoinedAt: expect.any(Number),
        },
        {
          userId: owner.subject,
          email: owner.email,
          role: "owner",
          lastJoinedAt: null,
        },
        {
          userId: visitor.subject,
          email: visitor.email,
          role: null,
          lastJoinedAt: expect.any(Number),
        },
      ]);
      expect(view.allowlist).toEqual([
        {
          email: guest.email,
          role: "editor",
          lastJoinedAt: expect.any(Number),
        },
      ]);
      expect(view).toMatchObject({ nextCursor: null, nextEmailCursor: null });
    });
  });
});

/** Backdates every queued job past the 24 h abandonment window and makes it due. */
function ageQueuedWork(state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE authority_work SET first_at=?, next_at=0",
    Date.now() - 24 * 60 * 60_000 - 1_000,
  );
}

function abandonedKinds(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter(
      (record): record is object =>
        typeof record === "object" &&
        record !== null &&
        Reflect.get(record, "event") === "authority.work_abandoned",
    )
    .map((record) => Reflect.get(record, "jobKind"));
}

describe("projection backlog and abandoned work", () => {
  it("still tombstones deleted invitations and members when the projection queue is full", async () => {
    const { roomId, stub } = fixture();
    const leaver: TrustedIdentity = {
      subject: "leaver",
      email: "leaver@example.com",
      lifecycleVersion: 1,
    };
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      for (const identity of [guest, leaver]) {
        await send(a, {
          action: "allow-email",
          email: identity.email,
          role: "editor",
        });
        await join(a, identity);
      }
      // Earlier projections were delivered; then the normal queue saturates.
      state.storage.sql.exec(
        "DELETE FROM authority_work WHERE id LIKE 'projection:%' OR id LIKE 'invite:%'",
      );
      let filled = 0;
      while (
        filled <= AUTHORITY_LIMITS.normalJobs &&
        a.work.enqueue(
          `filler:${filled}`,
          { kind: "cleanup", roomId, operationId: crypto.randomUUID() },
          false,
        )
      )
        filled++;
      expect(filled).toBeLessThanOrEqual(AUTHORITY_LIMITS.normalJobs);

      const removed = await send(a, {
        action: "remove-email",
        email: guest.email,
      });
      const left = await send(a, { action: "leave", actor: leaver });
      expect(
        state.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM authority_projection_backlog ORDER BY id",
          )
          .toArray()
          .map((row) => row.id),
      ).toEqual(
        expect.arrayContaining([
          `invite:${guest.email}`,
          `projection:${guest.subject}`,
          `invite:${leaver.email}`,
          `projection:${leaver.subject}`,
        ]),
      );
      expect(a.state()?.projection_dirty).toBe(1);

      // The queue drains; repair empties the backlog before clearing dirty.
      state.storage.sql.exec(
        "DELETE FROM authority_work WHERE id LIKE 'filler:%'",
      );
      for (let pass = 0; pass < 16 && a.state()?.projection_dirty; pass++)
        await a.repairProjections();
      expect(a.state()?.projection_dirty).toBe(0);
      expect(
        state.storage.sql
          .exec("SELECT * FROM authority_projection_backlog")
          .toArray(),
      ).toEqual([]);
      const { members, invites } = queuedProjections(state);
      expect(invites.get(guest.email)).toMatchObject({
        version: left.authRevision,
        tombstone: true,
      });
      expect(members.get(guest.subject)).toMatchObject({ tombstone: true });
      expect(invites.get(leaver.email)).toMatchObject({ tombstone: true });
      expect(members.get(leaver.subject)).toMatchObject({ tombstone: true });
      expect(left.authRevision).toBeGreaterThan(removed.authRevision);
    });
  });

  it("marks an abandoned content settlement's receipt terminal as refused", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      await send(a, {
        action: "create",
        sceneId: null,
        label: "",
        linkRole: "none",
      });
      const operation = {
        v: 1 as const,
        operationId: crypto.randomUUID(),
        roomId,
        actor: owner,
        deadline: Date.now() + 50_000,
        kind: "snapshot-put" as const,
        authorityEpoch: 1,
        expectedRevision: 0,
        checksum: "b".repeat(64),
      };
      expect(await a.acceptContent(operation)).toEqual({ status: "pending" });
      const error = vi.spyOn(console, "error");
      try {
        ageQueuedWork(state);
        await a.work.drain(async () => {
          throw new Error("delivery must not run for abandoned work");
        });
        expect(abandonedKinds(error)).toContain("settle-content");
      } finally {
        error.mockRestore();
      }
      expect(a.contentResult(operation.operationId)).toEqual({
        status: "refused",
      });
      expect(
        state.storage.sql
          .exec<{ terminal_at: number | null }>(
            "SELECT terminal_at FROM authority_content WHERE id=?",
            operation.operationId,
          )
          .one().terminal_at,
      ).not.toBeNull();
    });
  });

  it("lets management results waiting on an abandoned fence expire with their pending status", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      const removed = await send(a, {
        action: "remove-email",
        email: guest.email,
      });
      expect(removed.status).toBe("pending");
      const error = vi.spyOn(console, "error");
      try {
        ageQueuedWork(state);
        await a.work.drain(async () => {
          throw new Error("delivery must not run for abandoned work");
        });
        expect(abandonedKinds(error)).toContain("fence");
      } finally {
        error.mockRestore();
      }
      expect(a.query(removed.operationId)?.status).toBe("pending");
      expect(
        state.storage.sql
          .exec<{ terminal_at: number | null }>(
            "SELECT terminal_at FROM authority_results WHERE id=?",
            removed.operationId,
          )
          .one().terminal_at,
      ).not.toBeNull();
      a.work.prune(Date.now() + AUTHORITY_LIMITS.resultRetentionMs + 1);
      expect(a.query(removed.operationId)).toBeUndefined();
    });
  });

  it("keeps a superseded projection's first scheduling time, so it is still abandoned 24 h after it", async () => {
    const { roomId, stub } = fixture();
    await runInDurableObject(stub, async (_instance, state) => {
      const a = await readyAuthority(state, roomId, "none");
      await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "viewer",
      });
      const id = `invite:${guest.email}`;
      const firstAt = Date.now() - 24 * 60 * 60_000 - 1_000;
      state.storage.sql.exec(
        "UPDATE authority_work SET first_at=? WHERE id=?",
        firstAt,
        id,
      );
      const upgraded = await send(a, {
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      const row = state.storage.sql
        .exec<{ first_at: number; version: number }>(
          "SELECT first_at,version FROM authority_work WHERE id=?",
          id,
        )
        .one();
      expect(row).toEqual({
        first_at: firstAt,
        version: upgraded.authRevision,
      });
      state.storage.sql.exec(
        "UPDATE authority_work SET next_at=0 WHERE id=?",
        id,
      );
      const error = vi.spyOn(console, "error");
      try {
        await a.work.drain(async () => {});
        expect(abandonedKinds(error)).toEqual(["invite-projection"]);
      } finally {
        error.mockRestore();
      }
      expect(
        state.storage.sql
          .exec("SELECT id FROM authority_work WHERE id=?", id)
          .toArray(),
      ).toEqual([]);
    });
  });
});

describe("Lifecycle durable progress", () => {
  it("ignores a late page response after the retirement has advanced", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const name = `account:${subject}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(name);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    };
    await stub.begin(command);
    await runInDurableObject(stub, async (_instance, state) => {
      const p = new LifecycleProgress(state.storage, name);
      const page = { version: 2, rooms: [], cursor: null };
      let release: ((page: unknown) => void) | undefined;
      let lists = 0;
      let deletes = 0;
      const adapter: LifecycleAdapter = {
        freeze: async () => 2,
        list: () =>
          ++lists === 1
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(page),
        enforce: async () => "enforced",
        delete: async () => {
          deletes++;
        },
      };
      await p.advance(command, adapter);
      const late = p.advance(command, adapter);
      await p.advance(command, adapter);
      await p.advance(command, adapter);
      await p.advance(command, adapter);
      expect(p.query(command.operationId)?.phase).toBe("completed");
      release?.(page);
      await late;
      expect(p.query(command.operationId)?.phase).toBe("completed");
      expect(deletes).toBe(1);
    });
  });
  it("continues across eviction and never deletes before every room fence is enforced", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const name = `account:${subject}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(name);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    };
    await stub.begin(command);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const p = new LifecycleProgress(state.storage, name);
      let enforced = false;
      let deleted = 0;
      const adapter: LifecycleAdapter = {
        freeze: async () => 2,
        list: async () => ({
          version: 2,
          rooms: [{ roomId: "room-retire", action: "end-room" }],
          cursor: null,
        }),
        enforce: async () => (enforced ? "enforced" : "pending"),
        delete: async () => {
          deleted++;
        },
      };
      await p.advance(command, adapter);
      await p.advance(command, adapter);
      await expect(p.advance(command, adapter)).rejects.toThrow(
        "enforcement-pending",
      );
      expect(p.query(command.operationId)?.phase).toBe("enforcing");
      expect(deleted).toBe(0);
      enforced = true;
      await p.advance(command, adapter);
      await p.advance(command, adapter);
      expect(p.query(command.operationId)?.phase).toBe("deleting");
      expect(await p.advance(command, adapter)).toBe(true);
      expect(deleted).toBe(1);
      await p.advance(command, adapter);
      expect(deleted).toBe(1);
    });
  });
  it("releases a completed retirement's storage 24 h after completion, and not before", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const name = `account:${subject}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(name);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    };
    await stub.begin(command);
    const releaseAt = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const p = new LifecycleProgress(state.storage, name);
        const adapter: LifecycleAdapter = {
          freeze: async () => 2,
          list: async () => ({ version: 2, rooms: [], cursor: null }),
          enforce: async () => "enforced",
          delete: async () => {},
        };
        const completedAt = Date.now();
        for (let pass = 0; pass < 8 && p.work.pending() > 0; pass++) {
          state.storage.sql.exec("UPDATE authority_work SET next_at=0");
          await p.work.drain(
            async (job) => {
              if (job.kind !== "retire") throw new Error("wrong-job");
              return p.advance(job.command, adapter);
            },
            () => p.releaseAt(),
          );
        }
        expect(p.query(command.operationId)?.phase).toBe("completed");
        expect(p.work.pending()).toBe(0);
        const at = p.releaseAt();
        expect(at).toBeGreaterThanOrEqual(completedAt + 24 * 60 * 60_000);
        expect(at).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
        expect(p.releasable()).toBe(false);
        const alarm = await state.storage.getAlarm();
        expect(alarm).not.toBeNull();
        expect(alarm!).toBeLessThanOrEqual(at!);
        return at!;
      },
    );

    // A late duplicate begin answers from the record and keeps the release alarm.
    expect(await stub.begin(command)).toMatchObject({ phase: "completed" });
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(releaseAt);
    });

    // An alarm before the release time keeps everything and stays armed.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(userTables(state)).toContain("lifecycle_release");
      expect(new LifecycleProgress(state.storage, name).releaseAt()).toBe(
        releaseAt,
      );
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await stub.query(command.operationId)).toMatchObject({
      phase: "completed",
    });

    // Once the release time has passed, one alarm deletes all storage.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE lifecycle_release SET at=?",
        Date.now() - 1,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(userTables(state)).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("never releases a retirement that has not completed", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const name = `account:${subject}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(name);
    await stub.begin({
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    });
    // Delivery is unconfigured, so the retirement cannot progress.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      const p = new LifecycleProgress(state.storage, name);
      expect(p.releaseAt()).toBeUndefined();
      expect(p.releasable(Date.now() + 365 * 24 * 60 * 60_000)).toBe(false);
      expect(userTables(state)).toEqual(
        expect.arrayContaining(["authority_work", "lifecycle_release"]),
      );
      expect(p.work.pending()).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("never abandons lifecycle work, however old", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(`account:${subject}`);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    };
    await stub.begin(command);
    await runInDurableObject(stub, (_instance, state) => ageQueuedWork(state));
    const error = vi.spyOn(console, "error");
    try {
      // Delivery is unconfigured here, so the aged job fails and retries.
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(abandonedKinds(error)).toEqual([]);
    } finally {
      error.mockRestore();
    }
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT id FROM authority_work WHERE id='retirement'")
          .toArray(),
      ).toHaveLength(1);
    });
  });
  it("reschedules unconfigured delivery durably and binds the target and operation identity", async () => {
    const subject = `user-${crypto.randomUUID()}`;
    const stub = env.COLLABORATION_LIFECYCLE.getByName(`account:${subject}`);
    const command: LifecycleCommand = {
      v: 1,
      operationId: crypto.randomUUID(),
      actor: "admin",
      target: { kind: "account", subject },
    };
    await stub.begin(command);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    expect(await stub.query(command.operationId)).toMatchObject({
      phase: "freezing",
    });
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.begin({ ...command, actor: "someone-else" }),
      ).rejects.toThrow("operation-mismatch");
      expect(
        state.storage.sql
          .exec<{ attempts: number }>(
            "SELECT attempts FROM authority_work WHERE id='retirement'",
          )
          .one().attempts,
      ).toBeGreaterThan(0);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
