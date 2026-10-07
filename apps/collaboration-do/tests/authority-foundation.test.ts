import {
  env,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LIMITS,
  type RoomCommand,
  type TrustedIdentity,
  type LifecycleCommand,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { KEYCHECK_CIPHERTEXT_BYTES } from "@drawstuff/collaboration/keycheck";
import { RoomAuthority } from "../src/room-authority.ts";
import { LifecycleProgress, type LifecycleAdapter } from "../src/lifecycle.ts";

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

describe("persistent Room authority foundation", () => {
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

  it("requires confirmed initialization and preserves revocation through generation rotation", async () => {
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
      await a.apply({
        ...command("set-key-check"),
        action: "set-key-check",
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const complete = {
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: {
          authGeneration: 1,
          revision: 1,
          checksum: "a".repeat(64),
          assetIds: ["file-a"],
        },
      };
      expect((await a.apply(complete)).status).toBe("pending");
      await expect(
        a.confirmInitialization(complete.operationId, complete.manifest),
      ).rejects.toThrow("initialization-incomplete");
      await a.recordInitialAsset("file-a", 1);
      await a.confirmParent(a.state()!.create_operation);
      await a.confirmInitialization(complete.operationId, complete.manifest);
      expect(a.state()?.state).toBe("ready");
      await a.apply({
        ...command("join"),
        action: "join",
        actor: guest,
        registrationVersion: 1,
      });
      const revoked = await a.apply({
        ...command("revoke-member"),
        action: "revoke-member",
        subject: guest.subject,
      });
      expect(revoked.status).toBe("pending");
      expect(a.role(guest)).toBeUndefined();
      await a.confirmFence(revoked.authorityEpoch);
      expect(a.query(revoked.operationId)?.status).toBe("enforced");
      const createOperation = a.state()!.create_operation;
      await a.work.commit(() => {
        state.storage.sql.exec(
          "UPDATE authority_results SET terminal_at=0 WHERE id=?",
          createOperation,
        );
        a.work.prune();
      });
      expect(a.query(createOperation)).toBeUndefined();
      await a.apply({
        ...command("rotate-generation"),
        action: "rotate-generation",
        expectedGeneration: 1,
      });
      expect(a.state()?.auth_generation).toBe(2);
      expect(
        state.storage.sql
          .exec<{ revoked: number }>(
            "SELECT revoked FROM authority_members WHERE subject='guest'",
          )
          .one().revoked,
      ).toBe(1);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const a = new RoomAuthority(state.storage, roomId);
      expect(a.state()?.auth_generation).toBe(2);
      expect(a.role(guest)).toBeUndefined();
      expect(a.state()?.parent_confirmed).toBe(1);
      await a.apply({
        ...command("set-key-check"),
        action: "set-key-check",
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const complete = {
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: {
          authGeneration: 2,
          revision: 1,
          checksum: "b".repeat(64),
          assetIds: [],
        },
      };
      await a.apply(complete);
      await a.confirmInitialization(complete.operationId, complete.manifest);
      expect(a.state()?.state).toBe("ready");
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
        ...command("revoke-member"),
        action: "revoke-member",
        subject: guest.subject,
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
        authGeneration: 1,
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

  it("ends expired initialization, cancels completion work and refuses late finalization", async () => {
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
      await a.apply({
        ...command("set-key-check"),
        action: "set-key-check",
        keyCheck: new Uint8Array(KEYCHECK_CIPHERTEXT_BYTES),
      });
      const complete = {
        ...command("complete-initialization"),
        action: "complete-initialization" as const,
        manifest: {
          authGeneration: 1,
          revision: 1,
          checksum: "a".repeat(64),
          assetIds: [],
        },
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
      await expect(a.recordInitialAsset("late-file", 1)).rejects.toThrow(
        "ended",
      );
      const jobs = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM authority_work")
        .toArray();
      expect(jobs.some((row) => row.body.includes('"kind":"cleanup"'))).toBe(
        true,
      );
    });
  });

  it("removes an allowlisted address's active membership and retains the negative decision", async () => {
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
      state.storage.sql.exec("UPDATE authority_room SET state='ready'");
      await a.apply({
        ...command("allow-email"),
        action: "allow-email",
        email: "Guest@Example.com",
        role: "editor",
      });
      await a.apply({
        ...command("join"),
        action: "join",
        actor: guest,
        registrationVersion: 1,
      });
      expect(a.role(guest)).toBe("editor");
      await a.apply({
        ...command("set-member-role"),
        action: "set-member-role",
        subject: guest.subject,
        role: "viewer",
        registrationVersion: 1,
      });
      expect(a.role(guest)).toBe("viewer");
      await a.apply({
        ...command("remove-email"),
        action: "remove-email",
        email: "guest@example.com",
      });
      expect(a.role(guest)).toBeUndefined();
      await a.apply({
        ...command("set-link-role"),
        action: "set-link-role",
        linkRole: "editor",
      });
      expect(a.role(guest)).toBeUndefined();
      await a.retireSubject(owner.subject, 2);
      expect(a.state()).toMatchObject({
        state: "ended",
        projection_dirty: 1,
      });
    });
  });

  it("consults the allowlist only in restricted mode, while keeping member revocation authoritative", async () => {
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
      state.storage.sql.exec("UPDATE authority_room SET state='ready'");
      await a.apply({
        ...command("allow-email"),
        action: "allow-email",
        email: guest.email,
        role: "editor",
      });
      expect(a.role(guest)).toBe("editor");
      await a.apply({
        ...command("set-link-role"),
        action: "set-link-role",
        linkRole: "viewer",
      });
      expect(a.role(guest)).toBe("viewer");
      await a.apply({
        ...command("join"),
        action: "join",
        actor: guest,
        registrationVersion: 1,
      });
      await a.apply({
        ...command("revoke-member"),
        action: "revoke-member",
        subject: guest.subject,
      });
      expect(a.role(guest)).toBeUndefined();
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
