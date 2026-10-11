import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/server/db/schema";

/**
 * The admin console against a real PostgreSQL: the only e2e that needs one,
 * so it is opt-in. Run with a disposable database on the config's safe URL
 * and fake external credentials, e.g.
 *
 *   docker run -d -p 127.0.0.1:65432:5432 -e POSTGRES_USER=drawstuff \
 *     -e POSTGRES_PASSWORD=drawstuff -e POSTGRES_DB=drawstuff_e2e postgres:17
 *   SKIP_ENV_VALIDATION=1 POSTGRES_URL=<that URL> pnpm exec drizzle-kit push --force
 *   DRAWSTUFF_E2E_DATABASE=1 BETTER_AUTH_SECRET=e2e-secret \
 *     UPLOADTHING_TOKEN=fake UPSTASH_REDIS_REST_URL=http://127.0.0.1:9 \
 *     UPSTASH_REDIS_REST_TOKEN=fake \
 *     pnpm test:e2e tests/e2e/admin-console.spec.ts --project chromium-desktop
 *
 * Fake storage credentials matter: nothing here may reach production
 * storage, and "Run maintenance now" deletes queued objects.
 */
const DATABASE_URL =
  "postgres://drawstuff:drawstuff@127.0.0.1:65432/drawstuff_e2e";
const enabled = process.env.DRAWSTUFF_E2E_DATABASE === "1";

const ADMIN = "e2e-admin";
const TARGET = "e2e-target";
const ROOM_OPEN = "e2e-room-storage-open";
const SHARED = "e2e-shared-link";

test.describe.configure({ mode: "serial" });
test.skip(!enabled, "needs the disposable e2e PostgreSQL");

let sessionToken = "";
let publishedSceneId = "";

test.beforeAll(async () => {
  if (!enabled) return;
  const client = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const tables = await client<{ tablename: string }[]>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename like 'drawstuff_%'`;
    await db.execute(
      sql.raw(
        `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} cascade`,
      ),
    );

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 2 * 60 * 60_000);
    await db.insert(schema.user).values([
      {
        id: ADMIN,
        name: "E2E Admin",
        email: "admin@e2e.test",
        emailVerified: true,
      },
      { id: TARGET, name: "E2E Target", email: "target@e2e.test" },
    ]);
    await db.insert(schema.adminGrant).values({
      userId: ADMIN,
      role: "operator",
      grantSource: "bootstrap",
    });
    sessionToken = randomUUID();
    await db.insert(schema.session).values([
      {
        id: randomUUID(),
        token: sessionToken,
        userId: ADMIN,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        token: randomUUID(),
        userId: TARGET,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const [published] = await db
      .insert(schema.scene)
      .values({
        userId: TARGET,
        name: "E2E published scene",
        isPublished: true,
        publishedSlug: "e2e-published",
        publishedAt: now,
      })
      .returning({ id: schema.scene.id });
    publishedSceneId = published!.id;
    await db.insert(schema.sharedScene).values({
      sharedSceneId: SHARED,
      ownerId: TARGET,
      compressedData: Buffer.from("e2e"),
    });
    await db.insert(schema.collaborationRoom).values({
      roomId: ROOM_OPEN,
      ownerId: TARGET,
      status: "ended",
      storageState: "ready",
      endedAt: hourAgo,
    });
    await db.insert(schema.deferredFileCleanup).values({
      utFileKey: "e2e-failed-key",
      reason: "delete-scene",
      status: "failed",
      attempts: 6,
      lastError: "storage refused",
    });
    await db.insert(schema.maintenanceRun).values({
      trigger: "cron",
      status: "succeeded",
      startedAt: hourAgo,
      report: JSON.stringify({
        failed: 0,
        jobs: [
          {
            name: "record-retention",
            status: "ok",
            detail: { auditEvents: 0 },
          },
          {
            name: "drain-cleanup-queue",
            status: "ok",
            detail: { processed: 0, remaining: 0 },
          },
        ],
      }),
    });
  } finally {
    await client.end();
  }
});

/** Signs in as the seeded operator with a real Better Auth session cookie. */
async function signIn(page: Page) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set for this run");
  const signature = createHmac("sha256", secret)
    .update(sessionToken)
    .digest("base64");
  const url = new URL(test.info().project.use.baseURL ?? "");
  await page.context().addCookies([
    {
      name: "better-auth.session_token",
      value: encodeURIComponent(`${sessionToken}.${signature}`),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** Types the target ID into the typed-confirmation dialog and confirms. */
async function confirmTyped(page: Page, targetId: string, label: string) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Enter the target ID to confirm").fill(targetId);
  await dialog.getByRole("button", { name: label }).click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "the console is a desktop operator tool",
  );
});

test("the overview shows every operator section with seeded data", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin");

  for (const heading of [
    "Needs attention",
    "Data release",
    "Controls",
    "Maintenance",
    "Failed file cleanup",
    "Room lookup",
    "Users and permissions",
    "Recent audit log",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();

  // Data release: every kind is listed, the fence says why it is kept.
  const release = page.locator("section", {
    has: page.locator("#release-heading"),
  });
  await expect(release.getByRole("row")).toHaveCount(18);
  await expect(
    release.getByRole("row", { name: /Room creation fences/ }),
  ).toContainText("Kept on purpose");
  await expect(release.getByText(/^Neon: /)).toBeVisible();

  // Maintenance: the seeded run and an unreachable Worker in this sandbox.
  const maintenance = page.locator("section", {
    has: page.locator("#maintenance-heading"),
  });
  await expect(maintenance.getByText("drain-cleanup-queue")).toBeVisible();
  await expect(maintenance.getByText(/Unreachable/)).toBeVisible();
  await expect(
    maintenance.getByText(/set CLOUDFLARE_ACCOUNT_ID/),
  ).toBeVisible();

  await page.screenshot({
    path: test.info().outputPath("admin-overview.png"),
    fullPage: true,
  });
});

test("operators fix anomalies, toggle collaboration, and set limits", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin");

  // Close the storage of an ended room whose fence never arrived.
  const anomalies = page.locator("section", {
    has: page.locator("#anomalies-heading"),
  });
  await expect(anomalies.getByText(ROOM_OPEN)).toBeVisible();
  await anomalies.getByRole("button", { name: "Close storage" }).click();
  await confirmTyped(page, ROOM_OPEN, "Close storage");
  await expect(page.getByText("Room storage closed.")).toBeVisible();
  await expect(anomalies.getByText(ROOM_OPEN)).toHaveCount(0);

  // Retry the failed cleanup row.
  const failed = page.locator("section", {
    has: page.locator("#failed-cleanup-heading"),
  });
  await failed.getByRole("button", { name: "Retry all" }).click();
  await confirmTyped(page, "all", "Retry");
  await expect(failed.getByText("No failed cleanup tasks.")).toBeVisible();

  // Turn collaboration off and back on.
  const controls = page.locator("section", {
    has: page.locator("#controls-heading"),
  });
  await controls
    .getByRole("button", { name: "Turn off collaboration" })
    .click();
  await confirmTyped(page, "collab-rooms-disabled", "Turn off collaboration");
  await expect(controls.getByText("Off", { exact: true })).toBeVisible();
  await controls
    .getByRole("button", { name: "Turn collaboration back on" })
    .click();
  await confirmTyped(
    page,
    "collab-rooms-disabled",
    "Turn collaboration back on",
  );
  await expect(controls.getByText("On", { exact: true })).toBeVisible();

  // Lower the live-room limit.
  const rooms = controls.getByRole("textbox", { name: "Live rooms" });
  await rooms.fill("3");
  await controls
    .getByRole("listitem")
    .filter({ hasText: "Live rooms" })
    .getByRole("button", { name: "Save" })
    .click();
  await confirmTyped(page, "quota:activeRooms", "Save");
  await expect(page.getByText("Limit saved.")).toBeVisible();
  await expect(rooms).toHaveValue("3");

  // A storage scan with fake credentials fails visibly, not silently.
  const release = page.locator("section", {
    has: page.locator("#release-heading"),
  });
  await release.getByRole("button", { name: "Scan storage" }).click();
  await expect(page.locator("[data-sonner-toast]").last()).toBeVisible();

  // Every action above is in the audit log.
  const audit = page.locator("section", {
    has: page.locator("#audit-heading"),
  });
  for (const action of [
    "Close room storage",
    "Retry file cleanup",
    "Turn off collaboration",
    "Turn on collaboration",
    "Change limit",
  ])
    await expect(
      audit.getByRole("cell", { name: action, exact: true }).first(),
    ).toBeVisible();
});

test("operators look up a room and take an account's content down", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin");

  const lookup = page.locator("section", {
    has: page.locator("#room-lookup-heading"),
  });
  await lookup.getByPlaceholder("Room ID").fill(ROOM_OPEN);
  await lookup.getByRole("button", { name: "Search" }).click();
  await expect(lookup.getByText("storage ended")).toBeVisible();

  await page.goto(`/admin/users/${TARGET}`);
  await expect(
    page.getByRole("heading", { name: "Storage and exposure" }),
  ).toBeVisible();
  await expect(page.getByText("/p/e2e-published")).toBeVisible();
  await expect(page.getByText(SHARED)).toBeVisible();

  await page.getByRole("button", { name: "Unpublish" }).click();
  await confirmTyped(page, publishedSceneId, "Unpublish");
  await expect(page.getByText("Scene unpublished.")).toBeVisible();
  await expect(page.getByText("/p/e2e-published")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete link" }).click();
  await confirmTyped(page, SHARED, "Delete link");
  await expect(page.getByText("Shared link deleted.")).toBeVisible();

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await confirmTyped(page, TARGET, "Sign out everywhere");
  await expect(page.getByText("Signed out of 1 session(s).")).toBeVisible();

  await page.screenshot({
    path: test.info().outputPath("admin-user.png"),
    fullPage: true,
  });
});
