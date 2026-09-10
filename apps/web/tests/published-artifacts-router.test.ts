// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit/shared-scene", () => ({
  enforcePublicSceneReadRateLimit: () => Promise.resolve(),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import { createCaller } from "@/server/api/root";
import type { createTRPCContext } from "@/server/api/trpc";
import * as schema from "@/server/db/schema";
import {
  isUploadThingFileUrl,
  PUBLISHED_ARTIFACT_CLAIM_SAFETY_MARGIN_MS,
  PUBLISHED_ARTIFACT_CLAIM_WINDOW_MS,
  PUBLISHED_ARTIFACT_RESERVATION_REASON,
  reservePublishedArtifactUpload,
} from "@/server/scene/published-artifacts";

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const client = new PGlite();
const testDb = drizzle(client, { schema });
// The server module is typed against the postgres-js database; PGlite speaks
// the same SQL and the tests exercise it through that signature.
const executor = testDb as unknown as Parameters<
  typeof reservePublishedArtifactUpload
>[0];

const OWNER = "owner-user";
const OTHER = "other-user";

function callerFor(userId: string) {
  return createCaller({
    db: testDb,
    headers: new Headers(),
    auth: { session: { id: `session-${userId}` }, user: { id: userId } },
  } as unknown as TRPCContext);
}

const publicCaller = () =>
  createCaller({
    db: testDb,
    headers: new Headers(),
    auth: null,
  } as unknown as TRPCContext);

const urlOf = (key: string) => `https://app.ufs.sh/f/${key}`;

function artifactsOf(key: string, revision: number) {
  return {
    artifact: { key, url: urlOf(key) },
    engineVersion: "0.18.1",
    revision,
  };
}

/** What the upload handler does once the object has landed. */
async function reserveArtifact(sceneId: string, key: string, now?: Date) {
  await reservePublishedArtifactUpload(executor, {
    sceneId,
    fileKey: key,
    now,
  });
}

async function insertScene(
  userId: string,
  overrides: Partial<typeof schema.scene.$inferInsert> = {},
) {
  const [row] = await testDb
    .insert(schema.scene)
    .values({ name: "scene", userId, sceneData: "stub", ...overrides })
    .returning({ id: schema.scene.id });
  if (!row) throw new Error("scene insert failed");
  return row.id;
}

const sceneRow = async (id: string) =>
  (await testDb.select().from(schema.scene).where(eq(schema.scene.id, id)))[0]!;

const queue = async () =>
  (await testDb.select().from(schema.deferredFileCleanup))
    .map((task) => [task.utFileKey, task.reason, task.status] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

beforeAll(async () => {
  const { apply } = await pushSchema(
    schema,
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  await apply();
});

afterAll(() => client.close());

beforeEach(async () => {
  await testDb.delete(schema.deferredFileCleanup);
  await testDb.delete(schema.scene);
  await testDb.delete(schema.user);
  await testDb.insert(schema.user).values([
    { id: OWNER, name: "Owner", email: "owner@example.com" },
    { id: OTHER, name: "Other", email: "other@example.com" },
  ]);
});

describe("isUploadThingFileUrl", () => {
  it("accepts only the provider URL of the given key", () => {
    expect(isUploadThingFileUrl(urlOf("k1"), "k1")).toBe(true);
    expect(isUploadThingFileUrl(urlOf("k2"), "k1")).toBe(false);
    expect(isUploadThingFileUrl("https://evil.example/f/k1", "k1")).toBe(false);
    expect(isUploadThingFileUrl("http://app.ufs.sh/f/k1", "k1")).toBe(false);
    expect(isUploadThingFileUrl(`${urlOf("k1")}?x=1`, "k1")).toBe(false);
    expect(isUploadThingFileUrl("not a url", "k1")).toBe(false);
  });
});

describe("scene.publish", () => {
  it("refuses to publish without artifacts", async () => {
    const sceneId = await insertScene(OWNER);
    await expect(
      // @ts-expect-error — the artifacts are what this test leaves out.
      callerFor(OWNER).scene.publish({ id: sceneId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await sceneRow(sceneId)).isPublished).toBe(false);
  });

  it("rejects an artifact URL that is not the storage URL of its key", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    const artifacts = artifactsOf("a", 1);
    artifacts.artifact.url = "https://attacker.example/anything.svg";
    await expect(
      callerFor(OWNER).scene.publish({ id: sceneId, artifacts }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("claims the reserved artifact, assigns a slug and publishes in one transaction", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");

    const result = await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("a", 1),
    });

    expect(result.alreadyPublished).toBe(false);
    expect(result.slug).toHaveLength(12);
    const row = await sceneRow(sceneId);
    expect(row).toMatchObject({
      isPublished: true,
      publishedSlug: result.slug,
      publishedSvgKey: "a",
      publishedSvgUrl: urlOf("a"),
      publishedRenderEngineVersion: "0.18.1",
      publishedRenderedRevision: 1,
    });
    expect(row.publishedRenderedAt).toBeInstanceOf(Date);
    // The reservation was consumed: nothing is left for the drain.
    expect(await queue()).toEqual([]);
  });

  it("refuses artifacts whose reservation is missing or already due", async () => {
    const sceneId = await insertScene(OWNER);
    // A different object was reserved; the one being published never landed.
    await reserveArtifact(sceneId, "other");
    await expect(
      callerFor(OWNER).scene.publish({
        id: sceneId,
        artifacts: artifactsOf("a", 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await sceneRow(sceneId)).isPublished).toBe(false);
    // The unrelated reservation is untouched and stays for the drain.
    expect(await queue()).toEqual([
      ["other", PUBLISHED_ARTIFACT_RESERVATION_REASON, "pending"],
    ]);

    // Reserved long enough ago that the drain owns the object now.
    const sceneB = await insertScene(OWNER);
    await reserveArtifact(
      sceneB,
      "b",
      new Date(Date.now() - PUBLISHED_ARTIFACT_CLAIM_WINDOW_MS - 1000),
    );
    await expect(
      callerFor(OWNER).scene.publish({
        id: sceneB,
        artifacts: artifactsOf("b", 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await sceneRow(sceneB)).publishedSvgKey).toBeNull();
  });

  it("replaces the artifacts when the scene is already published", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    const first = await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("a", 1),
    });

    await reserveArtifact(sceneId, "b");
    const second = await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("b", 2),
    });

    expect(second).toEqual({ slug: first.slug, alreadyPublished: true });
    expect(await sceneRow(sceneId)).toMatchObject({
      publishedSvgKey: "b",
      publishedRenderedRevision: 2,
    });
    expect(await queue()).toEqual([
      ["a", "replace-published-artifacts", "pending"],
    ]);
  });

  it("is owner-only", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    await expect(
      callerFor(OTHER).scene.publish({
        id: sceneId,
        artifacts: artifactsOf("a", 1),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scene.setPublishedArtifacts", () => {
  async function publishedScene() {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("a", 3),
    });
    return sceneId;
  }

  it("replaces the artifact and queues the previous one", async () => {
    const sceneId = await publishedScene();
    await reserveArtifact(sceneId, "b");

    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("b", 4),
      }),
    ).resolves.toEqual({ applied: true });

    expect(await sceneRow(sceneId)).toMatchObject({
      publishedSvgKey: "b",
      publishedRenderedRevision: 4,
    });
    expect(await queue()).toEqual([
      ["a", "replace-published-artifacts", "pending"],
    ]);
  });

  it("does not let a stale render overwrite a newer one", async () => {
    const sceneId = await publishedScene();
    await reserveArtifact(sceneId, "old");

    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("old", 2),
      }),
    ).resolves.toEqual({ applied: false, reason: "stale" });

    expect((await sceneRow(sceneId)).publishedSvgKey).toBe("a");
    // The stale object keeps its reservation and expires with it.
    expect(await queue()).toEqual([
      ["old", PUBLISHED_ARTIFACT_RESERVATION_REASON, "pending"],
    ]);
  });

  it("leaves an unrelated reservation alone when the claim fails", async () => {
    const sceneId = await publishedScene();
    // Some other object of this scene is mid-flight; the one being applied
    // never landed. The failed claim must not consume the bystander.
    await reserveArtifact(sceneId, "bystander");

    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("never-landed", 4),
      }),
    ).resolves.toEqual({ applied: false, reason: "unclaimed" });

    expect((await sceneRow(sceneId)).publishedSvgKey).toBe("a");
    // The valid reservation is not consumed: the drain still owns that object.
    expect(await queue()).toEqual([
      ["bystander", PUBLISHED_ARTIFACT_RESERVATION_REASON, "pending"],
    ]);
  });

  it("refuses an artifact whose reservation is about to fall due", async () => {
    const sceneId = await publishedScene();
    await reserveArtifact(
      sceneId,
      "late",
      new Date(
        Date.now() -
          PUBLISHED_ARTIFACT_CLAIM_WINDOW_MS +
          PUBLISHED_ARTIFACT_CLAIM_SAFETY_MARGIN_MS / 2,
      ),
    );
    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("late", 4),
      }),
    ).resolves.toEqual({ applied: false, reason: "unclaimed" });
    expect((await queue()).map(([key]) => key)).toEqual(["late"]);
  });

  it("reports an unclaimed artifact instead of referencing it", async () => {
    const sceneId = await publishedScene();
    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("never-uploaded", 4),
      }),
    ).resolves.toEqual({ applied: false, reason: "unclaimed" });
    expect((await sceneRow(sceneId)).publishedSvgKey).toBe("a");
  });

  it("ignores artifacts for a scene that is not published", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    await expect(
      callerFor(OWNER).scene.setPublishedArtifacts({
        id: sceneId,
        artifacts: artifactsOf("a", 1),
      }),
    ).resolves.toEqual({ applied: false, reason: "not-published" });
    expect((await sceneRow(sceneId)).publishedSvgKey).toBeNull();
  });
});

describe("scene.unpublish and getPublishedSceneBySlug", () => {
  it("serves the artifact URL publicly and clears it with the outbox on unpublish", async () => {
    const sceneId = await insertScene(OWNER, { name: "Public" });
    await reserveArtifact(sceneId, "a");
    const { slug } = await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("a", 1),
    });

    const served = await publicCaller().scene.getPublishedSceneBySlug({ slug });
    expect(served?.artifacts).toMatchObject({
      url: urlOf("a"),
      engineVersion: "0.18.1",
    });
    expect(served?.artifacts?.renderedAt).toBeInstanceOf(Date);

    await callerFor(OWNER).scene.unpublish({ id: sceneId });

    expect(await sceneRow(sceneId)).toMatchObject({
      isPublished: false,
      publishedSlug: null,
      publishedSvgKey: null,
      publishedSvgUrl: null,
      publishedRenderEngineVersion: null,
      publishedRenderedRevision: null,
      publishedRenderedAt: null,
    });
    expect(await queue()).toEqual([["a", "unpublish-scene", "pending"]]);
    expect(
      await publicCaller().scene.getPublishedSceneBySlug({ slug }),
    ).toBeNull();
  });

  it("treats a published scene without artifacts as absent", async () => {
    // Cannot arise through the API (publish requires artifacts, unpublish
    // clears them); a manually edited row must not yield a blank page.
    await insertScene(OWNER, {
      isPublished: true,
      publishedSlug: "no-artifacts-1",
    });
    expect(
      await publicCaller().scene.getPublishedSceneBySlug({
        slug: "no-artifacts-1",
      }),
    ).toBeNull();
  });

  it("never exposes the scene document or asset records publicly", async () => {
    const sceneId = await insertScene(OWNER);
    await reserveArtifact(sceneId, "a");
    const { slug } = await callerFor(OWNER).scene.publish({
      id: sceneId,
      artifacts: artifactsOf("a", 1),
    });
    const served = await publicCaller().scene.getPublishedSceneBySlug({ slug });
    expect(served).not.toHaveProperty("sceneData");
    expect(served).not.toHaveProperty("files");
  });
});
