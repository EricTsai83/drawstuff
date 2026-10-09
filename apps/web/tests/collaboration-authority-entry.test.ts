import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
vi.mock("server-only", () => ({}));
import { authorityRequestSchema } from "@drawstuff/collaboration/authority";
import { verifyIdentityProof } from "@drawstuff/collaboration/room-token";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { issueAuthorityIdentity } from "@/server/collab/authority-identity";
import {
  registerAuthorityCommand,
  createAuthorityParent,
} from "@/server/collab/authority-registration";
import { callAuthorityGateway } from "@/server/collab/authority-gateway";
import { applyStorageFence } from "@/server/collab/authority-storage";
import type { Database } from "@/server/collab/rooms";
import {
  collaborationCreationFence,
  collaborationLifecycleRegistration,
  collaborationLifecycleSubject,
  collaborationRoom,
  session,
  user,
  scene,
} from "@/server/db/schema";
import { createTestDatabase, registerTestDatabase } from "./support/pglite-db";
import { adapterFixture } from "./support/authority-adapter-fixtures";
// PGlite uses the same generated schema and SQL; only its driver's result types differ.
let captureQueries: string[] | undefined;
const databaseHandle = createTestDatabase((query) =>
  captureQueries?.push(query),
);
registerTestDatabase(databaseHandle);
const db = databaseHandle.testDb as unknown as Database;
const secret = "identity-proof-purpose-only-test-secret";
async function fixture() {
  const f = await adapterFixture(db);
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, f.owner));
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, f.guest));
  const sessionId = crypto.randomUUID();
  await db.insert(session).values({
    id: sessionId,
    userId: f.owner,
    token: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 100_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const roomId = f.roomId;
  const registration = {
    v: 1 as const,
    action: "register" as const,
    operationId: crypto.randomUUID(),
    roomId,
    identity: f.operation().actor,
    ownerId: f.owner,
    sceneId: null,
    create: true,
  };
  // The fixture's parent row stands for the room this create made.
  await db
    .update(collaborationRoom)
    .set({ createOperationId: registration.operationId })
    .where(eq(collaborationRoom.roomId, roomId));
  return { ...f, sessionId, registration };
}
describe("formal identity and pre-activation registration", () => {
  it("avoids lifecycle inserts on repeated identity and source registration, while retaining row locks", async () => {
    const f = await fixture();
    const [source] = await db
      .insert(scene)
      .values({ userId: f.owner, name: "source", sceneData: "{}" })
      .returning();
    const linked = { ...f.registration, sceneId: source!.id };
    await registerAuthorityCommand(db, linked);
    const queries: string[] = [];
    captureQueries = queries;
    try {
      await registerAuthorityCommand(db, linked);
      await issueAuthorityIdentity(
        db,
        { subject: f.owner, sessionId: f.sessionId, roomId: f.roomId },
        secret,
      );
      const lifecycleQueries = queries.filter((statement) =>
        statement.includes('"drawstuff_collaboration_lifecycle_subject"'),
      );
      expect(lifecycleQueries).toHaveLength(3);
      expect(
        lifecycleQueries.every(
          (statement) =>
            statement.startsWith("select ") && statement.endsWith("for update"),
        ),
      ).toBe(true);
      expect(
        lifecycleQueries.some((statement) => statement.startsWith("insert ")),
      ).toBe(false);
    } finally {
      captureQueries = undefined;
    }
    await db
      .update(collaborationLifecycleSubject)
      .set({ frozen: true })
      .where(eq(collaborationLifecycleSubject.scope, `scene:${source!.id}`));
    await expect(registerAuthorityCommand(db, linked)).rejects.toThrow(
      "fence-mismatch",
    );
  });

  it("replays an existing registration while still enforcing live lifecycle and create intent", async () => {
    const f = await fixture();
    const receipt = await registerAuthorityCommand(db, f.registration);
    const storedVersion = () =>
      db
        .select({ version: sql<string>`xmin::text` })
        .from(collaborationLifecycleRegistration)
        .where(
          and(
            eq(collaborationLifecycleRegistration.subject, f.owner),
            eq(collaborationLifecycleRegistration.roomId, f.roomId),
          ),
        );
    const before = await storedVersion();
    expect(await registerAuthorityCommand(db, f.registration)).toEqual(receipt);
    expect(await storedVersion()).toEqual(before);
    // Another create for a claimed roomId is refused before it can register.
    await expect(
      registerAuthorityCommand(db, {
        ...f.registration,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("fence-mismatch");
    await db
      .update(collaborationLifecycleSubject)
      .set({ frozen: true })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await expect(registerAuthorityCommand(db, f.registration)).rejects.toThrow(
      "fence-mismatch",
    );
  });
  it("promotes an existing non-owner registration without changing its lifecycle version", async () => {
    const f = await fixture();
    await registerAuthorityCommand(db, f.registration);
    await db
      .update(collaborationLifecycleRegistration)
      .set({ owner: false })
      .where(eq(collaborationLifecycleRegistration.roomId, f.roomId));
    await registerAuthorityCommand(db, f.registration);
    const [registered] = await db
      .select()
      .from(collaborationLifecycleRegistration)
      .where(eq(collaborationLifecycleRegistration.roomId, f.roomId));
    expect(registered).toMatchObject({ owner: true, lifecycleVersion: 1 });
  });
  it("refreshes an existing registration's lifecycle version and preserves its owner flag", async () => {
    const f = await fixture();
    await registerAuthorityCommand(db, f.registration);
    await db
      .update(collaborationLifecycleSubject)
      .set({ version: 2 })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await registerAuthorityCommand(db, {
      ...f.registration,
      create: false,
      identity: { ...f.registration.identity, lifecycleVersion: 2 },
    });
    const [registered] = await db
      .select()
      .from(collaborationLifecycleRegistration)
      .where(
        and(
          eq(collaborationLifecycleRegistration.subject, f.owner),
          eq(collaborationLifecycleRegistration.roomId, f.roomId),
        ),
      );
    expect(registered).toMatchObject({
      lifecycleVersion: 2,
      owner: true,
      operationId: f.registration.operationId,
    });
  });
  it("issues identity only from the live account/session, without room roles", async () => {
    const f = await fixture();
    const issued = await issueAuthorityIdentity(
      db,
      { subject: f.owner, sessionId: f.sessionId, roomId: f.roomId },
      secret,
    );
    const proof = verifyIdentityProof({
      token: issued.proof,
      secret,
      expectedRoomId: f.roomId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error("invalid-proof");
    expect(proof.claims.identity).toEqual(f.registration.identity);
    expect(proof.claims).not.toHaveProperty("role");
    await db.delete(session).where(eq(session.id, f.sessionId));
    await expect(
      issueAuthorityIdentity(
        db,
        { subject: f.owner, sessionId: f.sessionId, roomId: f.roomId },
        secret,
      ),
    ).rejects.toThrow();
  });
  it("rejects frozen accounts, stale lifecycle proofs and changed verified email", async () => {
    const f = await fixture();
    await registerAuthorityCommand(db, f.registration);
    await db
      .update(collaborationLifecycleSubject)
      .set({ version: 2 })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await expect(registerAuthorityCommand(db, f.registration)).rejects.toThrow(
      "fence-mismatch",
    );
    await db
      .update(collaborationLifecycleSubject)
      .set({ version: 1, frozen: true })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await expect(
      issueAuthorityIdentity(
        db,
        { subject: f.owner, sessionId: f.sessionId, roomId: f.roomId },
        secret,
      ),
    ).rejects.toThrow("fence-mismatch");
    await db
      .update(collaborationLifecycleSubject)
      .set({ frozen: false })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await db
      .update(user)
      .set({ email: `changed-${f.owner}@example.com` })
      .where(eq(user.id, f.owner));
    await expect(registerAuthorityCommand(db, f.registration)).rejects.toThrow(
      "fence-mismatch",
    );
  });
  it("registers before a parent exists and binds create intent across retries", async () => {
    const f = await fixture();
    await db
      .delete(collaborationRoom)
      .where(eq(collaborationRoom.roomId, f.roomId));
    const receipt = await registerAuthorityCommand(db, f.registration);
    expect(receipt).toMatchObject({ roomId: f.roomId, lifecycleVersion: 1 });
    const parent = {
      v: 1 as const,
      action: "create-parent" as const,
      roomId: f.roomId,
      owner: f.registration.identity,
      createOperationId: f.registration.operationId,
      sceneId: null,
      label: "Independent",
      linkRole: "none" as const,
      initializationDeadline: Date.now() + 900_000,
    };
    expect(await createAuthorityParent(db, parent)).toEqual({
      roomId: f.roomId,
      createOperationId: parent.createOperationId,
    });
    expect(await createAuthorityParent(db, parent)).toEqual({
      roomId: f.roomId,
      createOperationId: parent.createOperationId,
    });
    // Another create for a claimed roomId is refused before it can register.
    await expect(
      registerAuthorityCommand(db, {
        ...f.registration,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("fence-mismatch");
    await db
      .delete(collaborationRoom)
      .where(eq(collaborationRoom.roomId, f.roomId));
    expect(
      await db
        .select()
        .from(collaborationLifecycleRegistration)
        .where(
          and(
            eq(collaborationLifecycleRegistration.subject, f.owner),
            eq(collaborationLifecycleRegistration.roomId, f.roomId),
          ),
        ),
    ).toHaveLength(1);
  });
  it("refuses every delayed parent after a terminal fence when the parent was never created", async () => {
    const f = await fixture();
    await db
      .delete(collaborationRoom)
      .where(eq(collaborationRoom.roomId, f.roomId));
    await registerAuthorityCommand(db, f.registration);
    await applyStorageFence(db, {
      v: 1,
      action: "fence",
      roomId: f.roomId,
      authorityEpoch: 2,
      state: "ended",
    });
    await expect(
      createAuthorityParent(db, {
        v: 1,
        action: "create-parent",
        roomId: f.roomId,
        owner: f.registration.identity,
        createOperationId: f.registration.operationId,
        sceneId: null,
        label: "",
        linkRole: "none",
        initializationDeadline: Date.now() + 900_000,
      }),
    ).rejects.toThrow("fence-mismatch");
    expect(
      await db.query.collaborationRoom.findFirst({
        where: eq(collaborationRoom.roomId, f.roomId),
      }),
    ).toBeUndefined();
  });
  it("checks source ownership and freeze, and the owner's live lifecycle for joiners", async () => {
    const f = await fixture();
    const [source] = await db
      .insert(scene)
      .values({ userId: f.owner, name: "source", sceneData: "{}" })
      .returning();
    const linked = { ...f.registration, sceneId: source!.id };
    await registerAuthorityCommand(db, linked);
    await db
      .update(collaborationLifecycleSubject)
      .set({ frozen: true })
      .where(eq(collaborationLifecycleSubject.scope, `scene:${source!.id}`));
    await expect(registerAuthorityCommand(db, linked)).rejects.toThrow(
      "fence-mismatch",
    );
    // Existing registration has a different optional source, so use another independent room identity.
    const join = {
      ...f.registration,
      create: false,
      roomId: roomIdSchema.parse(`${f.roomId}-x`),
      identity: {
        subject: f.guest,
        email: `${f.guest}@example.com`,
        lifecycleVersion: 1,
      },
    };
    expect(await registerAuthorityCommand(db, join)).toMatchObject({
      subject: f.guest,
      lifecycleVersion: 1,
    });
    await db
      .update(collaborationLifecycleSubject)
      .set({ frozen: true })
      .where(eq(collaborationLifecycleSubject.scope, `account:${f.owner}`));
    await expect(registerAuthorityCommand(db, join)).rejects.toThrow(
      "fence-mismatch",
    );
  });
  it("refuses a create that reuses a roomId, but accepts a retry of the same create", async () => {
    const f = await fixture();
    const fresh = (roomId: string) => ({
      ...f.registration,
      roomId: roomIdSchema.parse(roomId),
      operationId: crypto.randomUUID(),
    });
    // Retry of the create that made the existing parent row.
    await registerAuthorityCommand(db, f.registration);
    await expect(
      registerAuthorityCommand(db, f.registration),
    ).resolves.toMatchObject({ operationId: f.registration.operationId });
    // A parent row (live or ended) made by another create.
    await expect(registerAuthorityCommand(db, fresh(f.roomId))).rejects.toThrow(
      "fence-mismatch",
    );
    // Another owner already claimed the id before its parent exists.
    const claimed = fresh(`${f.roomId}-claimed`);
    await registerAuthorityCommand(db, claimed);
    await expect(
      registerAuthorityCommand(db, {
        ...fresh(claimed.roomId),
        identity: {
          subject: f.guest,
          email: `${f.guest}@example.com`,
          lifecycleVersion: 1,
        },
        ownerId: f.guest,
      }),
    ).rejects.toThrow("fence-mismatch");
    // An ended creation fence, even with no parent row or registration left.
    const ended = fresh(`${f.roomId}-ended`);
    await db
      .insert(collaborationCreationFence)
      .values({ roomId: ended.roomId, ended: true });
    await expect(registerAuthorityCommand(db, ended)).rejects.toThrow(
      "fence-mismatch",
    );
    const registered = (roomId: string) =>
      db
        .select({ subject: collaborationLifecycleRegistration.subject })
        .from(collaborationLifecycleRegistration)
        .where(eq(collaborationLifecycleRegistration.roomId, roomId));
    expect(await registered(claimed.roomId)).toEqual([{ subject: f.owner }]);
    expect(await registered(ended.roomId)).toEqual([]);
  });
  it("rejects caller-selected actors and lifecycle versions at the public contract", () => {
    const base = {
      v: 1,
      roomId: "room-a",
      operationId: crypto.randomUUID(),
      deadline: Date.now() + 55_000,
      action: "join",
    };
    expect(authorityRequestSchema.safeParse(base).success).toBe(true);
    expect(
      authorityRequestSchema.safeParse({ ...base, registrationVersion: 99 })
        .success,
    ).toBe(false);
    expect(
      authorityRequestSchema.safeParse({ ...base, actor: { subject: "owner" } })
        .success,
    ).toBe(false);
  });
  it("binds Gateway receipts and never treats a failed or oversized reply as success", async () => {
    const f = await fixture();
    const request = {
      v: 1 as const,
      roomId: f.roomId,
      operationId: crypto.randomUUID(),
      deadline: Date.now() + 55_000,
      action: "query" as const,
    };
    const config = { url: "https://gateway.example/v1/control", secret };
    const result = {
      operationId: request.operationId,
      status: "pending",
      authorityEpoch: 1,
      authRevision: 1,
      projectionPending: true,
    };
    expect(
      await callAuthorityGateway(
        config,
        "proof",
        request,
        async (_url, init) => {
          expect(init?.redirect).toBe("error");
          return Response.json({ ok: true, result });
        },
      ),
    ).toEqual(result);
    await expect(
      callAuthorityGateway(config, "proof", request, async () =>
        Response.json({
          ok: true,
          result: { ...result, operationId: crypto.randomUUID() },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      callAuthorityGateway(
        config,
        "proof",
        request,
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow();
    await expect(
      callAuthorityGateway(
        config,
        "proof",
        request,
        async () =>
          new Response(" ".repeat(65_537), {
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toThrow();
  });
});
