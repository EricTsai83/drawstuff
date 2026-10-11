/**
 * Production browser acceptance for plan 18D §2 / §5: a real Chromium drives
 * https://draw.ericts.com as two dedicated fixture accounts (no OAuth, no
 * personal data) through personal save/reload, share, publish, Library and
 * attachments, then room collaboration under offline, abnormal socket close,
 * failed and lost snapshot saves, reload and revocation.
 *
 * Cleanup uses the product's own account retirement, then deletes the
 * fixtures' provider objects and verifies no fixture rows remain. Evidence
 * (JSON report + screenshots) goes to .local/browser-acceptance-<runId>/.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { makeSignature } from "better-auth/crypto";
import { UTApi } from "uploadthing/server";
import { chromium } from "@playwright/test";
import * as schema from "../src/server/db/schema.ts";

const web = "https://draw.ericts.com";
const gateway = "https://drawstuff-collaboration-do.ericts.workers.dev";
for (const name of [
  "POSTGRES_URL",
  "BETTER_AUTH_SECRET",
  "UPLOADTHING_TOKEN",
  "COLLAB_AUTHORITY_SECRET",
])
  assert(process.env[name], `Missing ${name}`);
process.env.COLLAB_CONTROL_URL = gateway;

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const runId = randomUUID().slice(0, 8);
const evidenceDir = `${rootDir}.local/browser-acceptance-${runId}`;
await mkdir(evidenceDir, { recursive: true });
const report = (phase, fields = {}) =>
  console.log(JSON.stringify({ phase, ...fields }));
const sql = postgres(process.env.POSTGRES_URL, { max: 3 });
const db = drizzle(sql, { schema });
const utapi = new UTApi({
  token: process.env.UPLOADTHING_TOKEN,
  logLevel: "None",
});

const fixture = (role) => ({
  id: `browser-${role}-${runId}`,
  email: `browser-${role}-${runId}@example.invalid`,
  session: randomUUID(),
  token: randomUUID(),
});
const owner = fixture("owner"),
  guest = fixture("guest");
const sceneName = `Acceptance ${runId}`;
const results = [];
const evidence = {
  runId,
  startedAt: new Date().toISOString(),
  web,
  steps: results,
};
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    report("interrupt-requested-cleanup-will-run");
  });

// 1x1 PNG with a unique tEXt chunk, so each run uploads a new object.
function pngFixture() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const text = Buffer.from(`fixture\0${runId}`);
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length);
  chunk.write("tEXt", 4);
  text.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([
    png.subarray(0, -12),
    chunk,
    png.subarray(-12),
  ]).toString("base64");
}

async function step(page, name, run) {
  assert(!interrupted, "Acceptance interrupted");
  const started = Date.now();
  report("step-start", { name });
  try {
    const detail = await run();
    results.push({
      name,
      ok: true,
      ms: Date.now() - started,
      ...(detail && typeof detail === "object" ? { detail } : {}),
    });
    await page
      ?.screenshot({ path: `${evidenceDir}/${results.length}-${name}.png` })
      .catch(() => undefined);
    report("step-passed", { name });
    return detail;
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      errorName: error?.name,
      message: String(error?.message ?? error)
        .split("\n")[0]
        .slice(0, 300),
    });
    await page
      ?.screenshot({
        path: `${evidenceDir}/${results.length}-${name}-failed.png`,
      })
      .catch(() => undefined);
    report("step-failed", { name, errorName: error?.name });
    throw error;
  }
}

async function cookieFor(user) {
  return encodeURIComponent(
    `${user.token}.${await makeSignature(user.token, process.env.BETTER_AUTH_SECRET)}`,
  );
}
async function newContext(browser, user) {
  const context = await browser.newContext({
    viewport: { width: 1728, height: 1080 },
    acceptDownloads: true,
  });
  // English labels, and the anchor download path instead of the native save picker.
  await context.addInitScript(() => {
    localStorage.setItem("i18nextLng", "en");
    delete Window.prototype.showSaveFilePicker;
    delete window.showSaveFilePicker;
  });
  if (user)
    await context.addCookies([
      {
        name: "__Secure-better-auth.session_token",
        value: await cookieFor(user),
        domain: "draw.ericts.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  return context;
}
async function openCanvas(page, path = "/") {
  await page.goto(`${web}${path}`);
  await page.locator(".excalidraw").waitFor({ timeout: 60000 });
  await page.locator("canvas").first().waitFor();
}
/** Draws with Excalidraw's own toolbar button (`rectangle`, `ellipse`, `diamond`). */
async function draw(page, tool, at) {
  await page.keyboard.press("Escape");
  // The test id sits on a visually hidden radio input; its label is what a user clicks.
  await page
    .locator("label", { has: page.getByTestId(`toolbar-${tool}`) })
    .click();
  const box = await page.locator("canvas").first().boundingBox();
  const x = box.x + box.width * at[0],
    y = box.y + box.height * at[1];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}
const personalElements = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("excalidraw") ?? "[]")
      .filter((element) => !element.isDeleted)
      .map(({ id, type }) => ({ id, type })),
  );
async function dropImage(page) {
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "acceptance.png", { type: "image/png" }));
    const target = document.querySelector(".excalidraw");
    const rect = target.getBoundingClientRect();
    for (const type of ["dragenter", "dragover", "drop"])
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.left + rect.width * 0.7,
          clientY: rect.top + rect.height * 0.6,
        }),
      );
  }, pngFixture());
}
/** Opening a scene over a non-empty canvas asks first; the canvas holds the same scene here. */
async function confirmSwitch(page) {
  const dialog = page.getByRole("dialog", { name: "Switch scene?" });
  if (
    await dialog.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
  )
    await dialog.getByRole("button", { name: "Switch without saving" }).click();
  await dialog.waitFor({ state: "detached", timeout: 30000 });
}
async function quickAction(page, name) {
  await page.getByRole("button", { name: "Quick actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}
/** The collaboration menu item carries the room status in its accessible name. */
async function roomStatusIs(page, pattern) {
  await page.getByRole("button", { name: "Quick actions" }).click();
  const items = page.getByRole("menuitem", { name: pattern });
  const matched = await items
    .first()
    .waitFor({ timeout: 2000 })
    .then(
      async () =>
        (await items.first().getAttribute("aria-label")) ??
        (await items.first().textContent())?.trim() ??
        "matched",
      () => undefined,
    );
  await page.keyboard.press("Escape");
  return matched;
}
async function waitForStatus(page, pattern, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const matched = await roomStatusIs(page, pattern).catch(() => undefined);
    if (matched) return matched;
    await pause(1500);
  }
  throw new Error(`Room status did not reach ${pattern}`);
}
/** Opens the room badge popover and returns its storage status text. */
async function roomStorage(page, roomLabel) {
  await page.getByRole("button", { name: roomLabel }).click();
  const panel = page.getByTestId("editor-room-storage");
  await panel.waitFor();
  return panel;
}
async function waitForSave(page, roomLabel, pattern, timeout = 60000) {
  const panel = await roomStorage(page, roomLabel);
  await panel
    .getByRole("status")
    .filter({ hasText: pattern })
    .waitFor({ timeout });
  const text = (await panel.getByRole("status").textContent())?.trim();
  await page.keyboard.press("Escape");
  return text;
}
/**
 * The room's canvas as the product exports it, via "Download a local copy".
 * The export waits for every image to be hydrated, so it is retried for a
 * while; a refusal's toast text is kept for the failure report.
 */
async function roomElements(page, roomLabel, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let refusal;
  while (Date.now() < deadline) {
    const panel = await roomStorage(page, roomLabel);
    const download = page
      .waitForEvent("download", { timeout: 8000 })
      .catch(() => undefined);
    await panel.getByRole("button", { name: "Download a local copy" }).click();
    const file = await download;
    if (file) {
      const scene = JSON.parse(await readFile(await file.path(), "utf8"));
      await page.keyboard.press("Escape");
      return scene.elements
        .filter((element) => !element.isDeleted)
        .map(({ id, type }) => ({ id, type }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    refusal =
      (
        await page
          .locator("[data-sonner-toast]")
          .allTextContents()
          .catch(() => [])
      ).join(" | ") || refusal;
    await page.keyboard.press("Escape");
    await pause(2000);
  }
  throw new Error(
    `Room export never downloaded${refusal ? `: ${refusal}` : ""}`,
  );
}
/** Collaborator avatars the page shows (Excalidraw de-duplicates by user). */
const avatars = (page) => page.locator(".UserList__collaborator").count();
const roomIdOf = (link) => new URL(link).searchParams.get("collab-room");
async function roomAssetCounts(roomId) {
  const [row] =
    await sql`select (select count(*) from drawstuff_collaboration_asset where room_id=${roomId})::int as assets, (select count(*) from drawstuff_collaboration_snapshot where room_id=${roomId})::int as snapshots`;
  return row;
}

async function createFixtures() {
  await sql.begin(async (tx) => {
    for (const user of [owner, guest]) {
      await tx`insert into drawstuff_user (id,name,email,email_verified,created_at,updated_at) values (${user.id},'Automated browser acceptance',${user.email},true,now(),now())`;
      await tx`insert into drawstuff_session (id,user_id,token,expires_at,created_at,updated_at) values (${user.session},${user.id},${user.token},now()+interval '3 hours',now(),now())`;
    }
  });
  for (const user of [owner, guest]) {
    const response = await fetch(`${web}/api/auth/get-session`, {
      headers: {
        cookie: `__Secure-better-auth.session_token=${await cookieFor(user)}`,
      },
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(
      (await response.json())?.user?.id,
      user.id,
      "Production must recognize the fixture session",
    );
  }
}

async function cleanup() {
  const cleanupReport = {};
  const { collectUserStorageKeys } =
    await import("../src/server/storage/reclaim.ts");
  const keys = new Set();
  for (const user of [owner, guest]) {
    try {
      for (const key of await db.transaction((tx) =>
        collectUserStorageKeys(tx, user.id),
      ))
        keys.add(key);
    } catch {
      cleanupReport.keyCollectionIncomplete = true;
    }
  }
  // Room attachments are released by the room Object, not by account
  // retirement's key list; take them from the rooms the fixtures own.
  try {
    for (const row of await sql`select a.ut_file_key from drawstuff_collaboration_asset a join drawstuff_collaboration_room r on r.room_id = a.room_id where r.owner_id in (${owner.id},${guest.id})`)
      keys.add(row.ut_file_key);
  } catch {
    cleanupReport.keyCollectionIncomplete = true;
  }
  cleanupReport.providerKeys = keys.size;
  const { retireAccount } = await import("../src/server/admin/retirement.ts");
  for (const user of [owner, guest]) {
    const [exists] =
      await sql`select 1 from drawstuff_user where id=${user.id}`;
    if (!exists) continue;
    // A begin the gateway could not confirm is resumed by calling it again.
    let operationId;
    for (let attempt = 1; attempt <= 5 && !operationId; attempt++) {
      try {
        ({ operationId } = await retireAccount({ db, userId: user.id }));
      } catch (error) {
        if (attempt === 5) throw error;
        await pause(5000);
      }
    }
    const deadline = Date.now() + 180000;
    let phase;
    while (Date.now() < deadline) {
      const response = await fetch(`${gateway}/v1/lifecycle`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.COLLAB_AUTHORITY_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "query",
          target: { kind: "account", subject: user.id },
          operationId,
        }),
        signal: AbortSignal.timeout(20000),
      });
      phase = response.ok
        ? (await response.json()).phase
        : `http-${response.status}`;
      if (phase === "completed") break;
      await pause(3000);
    }
    cleanupReport[`${user === owner ? "owner" : "guest"}Retirement`] = phase;
  }
  // Retirement queues these keys for the weekly drain. Delete them now and
  // close only the queue rows of keys the provider confirmed deleting; a key
  // that failed stays queued so the drain still retries it.
  const deleted = [];
  for (const key of keys) {
    const result = await utapi.deleteFiles(key).catch(() => undefined);
    if (result?.success) deleted.push(key);
    else
      cleanupReport.providerDeleteFailures =
        (cleanupReport.providerDeleteFailures ?? 0) + 1;
  }
  if (deleted.length)
    await sql`update drawstuff_deferred_file_cleanup set status='done', updated_at=now() where ut_file_key in ${sql(deleted)} and status <> 'done'`;
  const [rows] = await sql`select
    (select count(*) from drawstuff_user where id in (${owner.id},${guest.id}))::int as users,
    (select count(*) from drawstuff_session where user_id in (${owner.id},${guest.id}))::int as sessions,
    (select count(*) from drawstuff_scene where user_id in (${owner.id},${guest.id}))::int as scenes,
    (select count(*) from drawstuff_collaboration_room where owner_id in (${owner.id},${guest.id}))::int as rooms,
    (select count(*) from drawstuff_shared_scene where owner_id in (${owner.id},${guest.id}))::int as shared,
    (select count(*) from drawstuff_personal_library where user_id in (${owner.id},${guest.id}))::int as libraries`;
  cleanupReport.remainingRows = rows;
  let remainingKeys = 0;
  if (keys.size) {
    // The whole inventory, page by page: a survivor past the first page counts.
    let complete = false;
    for (let offset = 0; offset < 100000; offset += 500) {
      const page = await utapi.listFiles({ limit: 500, offset });
      remainingKeys += page.files.filter((file) => keys.has(file.key)).length;
      if (!page.hasMore) {
        complete = true;
        break;
      }
    }
    if (!complete) cleanupReport.providerInventoryIncomplete = true;
  }
  cleanupReport.remainingProviderObjects = remainingKeys;
  cleanupReport.passed =
    Object.values(rows).every((count) => count === 0) &&
    remainingKeys === 0 &&
    !cleanupReport.providerInventoryIncomplete &&
    !cleanupReport.providerDeleteFailures &&
    !cleanupReport.keyCollectionIncomplete;
  return cleanupReport;
}

let browser,
  testPassed = false;
try {
  await createFixtures();
  report("fixtures-authenticated");
  browser = await chromium.launch();
  const ownerContext = await newContext(browser, owner),
    guestContext = await newContext(browser, guest),
    anonymous = await newContext(browser);
  const ownerPage = await ownerContext.newPage(),
    guestPage = await guestContext.newPage();

  // ---- §5: personal scene, attachment, share, publish, Library ----
  await step(ownerPage, "personal-save-with-image", async () => {
    await openCanvas(ownerPage);
    await draw(ownerPage, "rectangle", [0.3, 0.35]);
    await dropImage(ownerPage);
    await ownerPage.waitForFunction(
      () => {
        const live = JSON.parse(
          localStorage.getItem("excalidraw") ?? "[]",
        ).filter((element) => !element.isDeleted);
        return (
          live.some((element) => element.type === "image") &&
          live.some((element) => element.type === "rectangle")
        );
      },
      null,
      { timeout: 30000 },
    );
    await ownerPage.keyboard.press("ControlOrMeta+s");
    await ownerPage.getByLabel("Scene name").fill(sceneName);
    await ownerPage.getByRole("button", { name: "Confirm save" }).click();
    await ownerPage
      .getByText("Saved to my scenes.")
      .waitFor({ timeout: 60000 });
    return { elements: await personalElements(ownerPage) };
  });
  const savedElements = results.at(-1).detail.elements;
  const [savedScene] =
    await sql`select id from drawstuff_scene where user_id=${owner.id} and name=${sceneName}`;
  assert(savedScene, "Saved scene must exist");

  await step(ownerPage, "personal-reload-from-cloud", async () => {
    await ownerPage.evaluate(() => {
      for (const key of [
        "excalidraw",
        "excalidraw-state",
        "excalidraw-files",
        "excalidraw-current-scene-id",
      ])
        localStorage.removeItem(key);
    });
    await openCanvas(ownerPage);
    await ownerPage.getByRole("button", { name: "Open dashboard" }).click();
    await ownerPage
      .getByRole("link", { name: `Open ${sceneName} in the editor` })
      .click();
    await confirmSwitch(ownerPage);
    await ownerPage
      .getByRole("dialog", { name: "Dashboard" })
      .waitFor({ state: "detached", timeout: 30000 });
    await ownerPage.waitForFunction(
      (count) =>
        JSON.parse(localStorage.getItem("excalidraw") ?? "[]").filter(
          (element) => !element.isDeleted,
        ).length === count,
      savedElements.length,
      { timeout: 60000 },
    );
    const elements = await personalElements(ownerPage);
    assert.deepEqual(
      elements.map((e) => e.type).sort(),
      savedElements.map((e) => e.type).sort(),
    );
    const files = await ownerPage.evaluate(
      () =>
        Object.keys(
          JSON.parse(localStorage.getItem("excalidraw-files") ?? "{}"),
        ).length,
    );
    return { elements: elements.length, files };
  });

  await step(ownerPage, "share-link-opens-anonymously", async () => {
    await quickAction(ownerPage, "Share");
    const link = ownerPage.locator("#link");
    await ownerPage.waitForFunction(
      () => document.querySelector("#link")?.value?.includes("#json="),
      null,
      { timeout: 60000 },
    );
    const url = await link.inputValue();
    await ownerPage.keyboard.press("Escape");
    const viewer = await anonymous.newPage();
    await openCanvas(viewer, new URL(url).pathname + new URL(url).hash);
    await viewer.waitForFunction(
      (count) =>
        JSON.parse(localStorage.getItem("excalidraw") ?? "[]").filter(
          (element) => !element.isDeleted,
        ).length === count,
      savedElements.length,
      { timeout: 60000 },
    );
    await viewer.screenshot({ path: `${evidenceDir}/share-viewer.png` });
    await viewer.close();
    return { anonymousElements: savedElements.length };
  });

  await step(ownerPage, "publish-public-page", async () => {
    await ownerPage.getByRole("button", { name: "Open dashboard" }).click();
    const card = ownerPage.getByRole("link", {
      name: `Open ${sceneName} in the editor`,
    });
    await card.waitFor();
    await card
      .locator("xpath=ancestor::*[.//button[@aria-label='More options']][1]")
      .getByRole("button", { name: "More options" })
      .click();
    await ownerPage.getByRole("menuitem", { name: /Set to public/ }).click();
    let slug;
    for (let attempt = 0; attempt < 40 && !slug; attempt++) {
      [{ published_slug: slug } = {}] =
        await sql`select published_slug from drawstuff_scene where id=${savedScene.id} and is_published and published_svg_url is not null`;
      if (!slug) await pause(1500);
    }
    assert(slug, "Published artifact must be ready");
    await ownerPage.keyboard.press("Escape");
    const viewer = await anonymous.newPage();
    await viewer.goto(`${web}/p/${slug}`);
    await viewer
      .getByRole("img", { name: sceneName })
      .waitFor({ timeout: 60000 });
    await viewer.screenshot({ path: `${evidenceDir}/published-viewer.png` });
    await viewer.close();
    return { published: true };
  });

  await step(ownerPage, "library-persists", async () => {
    await ownerPage.keyboard.press("Escape");
    // Upstream refuses images in the Library, so add the rectangle alone: hit
    // its stroke (a transparent rectangle is only hit there) on screen.
    await pause(800); // let the 300 ms debounce persist the current scroll and zoom
    const canvasBox = await ownerPage.locator("canvas").first().boundingBox();
    const point = await ownerPage.evaluate(() => {
      const rectangle = JSON.parse(
        localStorage.getItem("excalidraw") ?? "[]",
      ).find((element) => element.type === "rectangle" && !element.isDeleted);
      const state = JSON.parse(
        localStorage.getItem("excalidraw-state") ?? "{}",
      );
      const zoom = state.zoom?.value ?? 1;
      return {
        x: (rectangle.x + state.scrollX) * zoom,
        y: (rectangle.y + rectangle.height / 2 + state.scrollY) * zoom,
      };
    });
    const saved = ownerPage.waitForResponse(
      (response) =>
        response.url().includes("personalLibrary.put") && response.ok(),
      { timeout: 60000 },
    );
    await ownerPage.mouse.click(canvasBox.x + point.x, canvasBox.y + point.y);
    await ownerPage.mouse.click(canvasBox.x + point.x, canvasBox.y + point.y, {
      button: "right",
    });
    await ownerPage.getByText("Add to library", { exact: true }).click();
    await saved;
    const [library] =
      await sql`select revision from drawstuff_personal_library where user_id=${owner.id}`;
    assert(library, "Library must be stored");
    return { revision: library.revision };
  });

  const personalBefore =
    await sql`select scene_data from drawstuff_scene where id=${savedScene.id}`;

  // ---- §2: room collaboration and recovery ----
  const roomName = `Room ${runId}`;
  let roomLink;
  await step(ownerPage, "owner-starts-room", async () => {
    await quickAction(ownerPage, "Collaborate");
    await ownerPage.locator("#collab-room-name").fill(roomName);
    await ownerPage
      .getByRole("button", { name: "Start collaboration" })
      .click();
    await ownerPage.locator("#collab-room-link").waitFor({ timeout: 60000 });
    await ownerPage
      .getByRole("combobox", { name: "Who can join with the link" })
      .click();
    await ownerPage
      .getByRole("option", { name: "Anyone with the link can edit" })
      .click();
    roomLink = await ownerPage.locator("#collab-room-link").inputValue();
    await ownerPage.keyboard.press("Escape");
    return { status: await waitForStatus(ownerPage, /^Collaborating/) };
  });

  // Every guest socket goes through this route, so a test can drop it.
  // Routed sockets connect from Playwright, outside the browser's network, so
  // "offline" must also drop the live socket and refuse new ones here.
  const guestSockets = [];
  let guestOffline = false;
  await guestContext.routeWebSocket(/\/v1\/rooms\/[^/]+\/socket/, (socket) => {
    if (guestOffline)
      return void socket.close({ code: 1001, reason: "acceptance offline" });
    const server = socket.connectToServer();
    guestSockets.push(socket);
    // Drops the link on both sides. In production the room Object still kept
    // these links as members afterwards, the way a silent network drop leaves
    // a dead peer behind (see "silent-drop-roster-observation").
    socket.drop = async (code, reason) => {
      await server.close({ code, reason });
      await socket.close({ code, reason });
    };
  });

  await step(guestPage, "guest-joins-and-sees-content", async () => {
    await openCanvas(
      guestPage,
      new URL(roomLink).pathname + new URL(roomLink).search,
    );
    await waitForStatus(guestPage, /^Collaborating/);
    const ownerView = await roomElements(ownerPage, roomName);
    let guestView;
    try {
      guestView = await roomElements(guestPage, roomName);
    } catch (error) {
      error.message += ` (room ${JSON.stringify(await roomAssetCounts(roomIdOf(roomLink)))})`;
      throw error;
    }
    assert.deepEqual(guestView, ownerView);
    return {
      elements: guestView.length,
      room: await roomAssetCounts(roomIdOf(roomLink)),
      ownerAvatars: await avatars(ownerPage),
      guestAvatars: await avatars(guestPage),
    };
  });

  // The room's snapshot writer is elected (lowest editing peerId), so a save
  // the owner asks for may be written by the guest's page. Faults are injected
  // on both contexts, and every snapshot request (page, action, status) is kept
  // as evidence of what the clients actually did.
  const snapshotLog = [];
  const snapshotAction = (request) => {
    try {
      return (
        JSON.parse(request.headers()["x-drawstuff-snapshot-request"] ?? "{}")
          .action ?? "unknown"
      );
    } catch {
      return "unparsed";
    }
  };
  for (const [who, page] of [
    ["owner", ownerPage],
    ["guest", guestPage],
  ]) {
    page.on("requestfinished", async (request) => {
      if (request.url().includes("/api/collaboration/snapshot"))
        snapshotLog.push({
          who,
          action: snapshotAction(request),
          status: (await request.response())?.status(),
        });
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/collaboration/snapshot"))
        snapshotLog.push({
          who,
          action: snapshotAction(request),
          failed: request.failure()?.errorText,
        });
    });
  }
  const isWrite = (request) =>
    request.method() === "POST" && snapshotAction(request) === "write";
  const roomContexts = [ownerContext, guestContext];
  const routeWrites = async (handler) => {
    for (const context of roomContexts)
      await context.route("**/api/collaboration/snapshot", (route) =>
        isWrite(route.request()) ? handler(route) : route.continue(),
      );
  };
  const unrouteWrites = async () => {
    for (const context of roomContexts)
      await context.unroute("**/api/collaboration/snapshot");
  };

  await step(ownerPage, "failed-save-then-saved", async () => {
    let refused = 0;
    await routeWrites((route) => {
      refused++;
      return route.fulfill({ status: 500, body: "acceptance failure" });
    });
    await draw(ownerPage, "ellipse", [0.45, 0.8]);
    await ownerPage.keyboard.press("ControlOrMeta+s");
    for (let i = 0; i < 90 && refused === 0; i++) await pause(1000);
    assert(
      refused > 0,
      `A snapshot write must be attempted (avatars ${await avatars(ownerPage)}, requests ${JSON.stringify(snapshotLog)})`,
    );
    // The requester reports failure once no save landed within the cadence.
    const failed = await waitForSave(
      ownerPage,
      roomName,
      /^Save failed$/,
      90000,
    );
    await unrouteWrites();
    await ownerPage.keyboard.press("ControlOrMeta+s");
    const saved = await waitForSave(ownerPage, roomName, /^Saved$/, 120000);
    return { refused, failed, saved, requests: snapshotLog.splice(0) };
  });

  await step(ownerPage, "lost-save-response-not-reported-saved", async () => {
    // The write reaches the server but its response is lost, and the query or
    // cancel that would report its outcome is blocked too. The client may only
    // show "Saved" if the content really is durable — it can learn that from a
    // durable read (verifyPersisted) — so "Saved" with no new stored revision
    // is the false success this step looks for.
    const roomId = roomIdOf(roomLink);
    const storedRevision = async () =>
      (
        await sql`select revision from drawstuff_collaboration_snapshot where room_id=${roomId}`
      )[0]?.revision ?? 0;
    const before = await storedRevision();
    let delivered = 0;
    for (const context of roomContexts)
      await context.route("**/api/collaboration/snapshot", async (route) => {
        const action = snapshotAction(route.request());
        if (action === "write") {
          await route.fetch();
          delivered++;
          return route.abort("connectionreset");
        }
        if (action === "query" || action === "cancel")
          return route.abort("failed");
        return route.continue();
      });
    await draw(ownerPage, "rectangle", [0.8, 0.3]);
    await ownerPage.keyboard.press("ControlOrMeta+s");
    for (let i = 0; i < 90 && delivered === 0; i++) await pause(1000);
    assert(delivered > 0, "A write must reach the server");
    // Settled outcome, observed while the fault is still installed.
    const during = await waitForSave(
      ownerPage,
      roomName,
      /^(Saved|Save failed)$/,
      90000,
    );
    const afterFault = await storedRevision();
    if (during === "Saved")
      assert(
        afterFault > before,
        "Saved was shown although no write is durable",
      );
    await unrouteWrites();
    await ownerPage.keyboard.press("ControlOrMeta+s");
    const saved = await waitForSave(ownerPage, roomName, /^Saved$/, 120000);
    return {
      during,
      revisionBefore: before,
      revisionDuringFault: afterFault,
      saved,
      delivered,
      requests: snapshotLog.splice(0),
    };
  });

  await step(guestPage, "offline-edits-converge", async () => {
    guestOffline = true;
    await guestContext.setOffline(true);
    await guestSockets.at(-1).drop(1001, "acceptance offline");
    await waitForStatus(guestPage, /Reconnecting|Connection stopped/, 90000);
    await draw(guestPage, "ellipse", [0.55, 0.25]); // guest adds while offline
    await draw(ownerPage, "diamond", [0.15, 0.7]); // owner keeps editing
    guestOffline = false;
    await guestContext.setOffline(false);
    await waitForStatus(guestPage, /^Collaborating/, 120000);
    await pause(3000);
    const ownerView = await roomElements(ownerPage, roomName),
      guestView = await roomElements(guestPage, roomName);
    assert.deepEqual(guestView, ownerView);
    assert(
      ownerView.some((e) => e.type === "ellipse") &&
        ownerView.some((e) => e.type === "diamond"),
    );
    return {
      elements: ownerView.length,
      ownerAvatars: await avatars(ownerPage),
      routedSockets: guestSockets.length,
    };
  });

  await step(guestPage, "abnormal-socket-close-recovers", async () => {
    const before = guestSockets.length;
    await guestSockets.at(-1).drop(1001, "acceptance drop");
    await waitForStatus(guestPage, /^Collaborating/, 120000);
    assert(guestSockets.length > before, "Guest must open a new socket");
    await draw(ownerPage, "rectangle", [0.65, 0.7]);
    await pause(3000);
    const ownerView = await roomElements(ownerPage, roomName),
      guestView = await roomElements(guestPage, roomName);
    assert.deepEqual(guestView, ownerView);
    return {
      reconnects: guestSockets.length - before,
      ownerAvatars: await avatars(ownerPage),
      routedSockets: guestSockets.length,
    };
  });

  // A link that drops without a close frame stays in the room roster until
  // the room's next alarm reaps it (liveness is judged lazily, see room.ts).
  // Recorded, not asserted: while such a ghost holds the lowest editing
  // peerId, it is the elected snapshot writer and durable saves stall.
  await step(ownerPage, "silent-drop-roster-observation", async () => {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push({
        afterSeconds: i * 15,
        ownerAvatars: await avatars(ownerPage),
      });
      if (i < 4) await pause(15000);
    }
    return { routedSockets: guestSockets.length, samples };
  });

  await step(ownerPage, "reload-restores-confirmed-room", async () => {
    const confirmed = await roomElements(ownerPage, roomName);
    await ownerPage.reload();
    await ownerPage.locator(".excalidraw").waitFor({ timeout: 60000 });
    await waitForStatus(ownerPage, /^Collaborating/, 120000);
    await pause(3000);
    assert.deepEqual(await roomElements(ownerPage, roomName), confirmed);
    return { elements: confirmed.length };
  });

  await step(guestPage, "revoked-guest-loses-access", async () => {
    await quickAction(ownerPage, /^Collaborating/);
    await ownerPage
      .getByRole("combobox", { name: "Who can join with the link" })
      .click();
    await ownerPage
      .getByRole("option", { name: "Invited people only" })
      .click();
    await ownerPage.keyboard.press("Escape");
    await guestPage
      .getByText(
        /access to this room was removed|don't have access to this room/,
      )
      .waitFor({ timeout: 90000 });
    await guestPage.reload();
    await guestPage
      .getByText(
        /don't have access to this room|access to this room was removed/,
      )
      .waitFor({ timeout: 90000 });
    return { revoked: true };
  });

  await step(ownerPage, "back-to-personal-canvas-is-untouched", async () => {
    const panel = await roomStorage(ownerPage, roomName);
    await panel.getByRole("button", { name: "Back to my canvas" }).click();
    await ownerPage
      .getByRole("button", { name: roomName })
      .waitFor({ state: "detached", timeout: 30000 });
    const personalAfter =
      await sql`select scene_data from drawstuff_scene where id=${savedScene.id}`;
    assert.equal(
      personalAfter[0].scene_data,
      personalBefore[0].scene_data,
      "Room edits must not overwrite the personal scene",
    );
    return { personalSceneUnchanged: true };
  });

  testPassed = results.every((entry) => entry.ok);
} catch (error) {
  report("test-failed", {
    errorName: error?.name,
    message: String(error?.message ?? error)
      .split("\n")[0]
      .slice(0, 300),
  });
} finally {
  await browser?.close().catch(() => undefined);
  try {
    evidence.cleanup = await cleanup();
  } catch (error) {
    evidence.cleanup = {
      passed: false,
      errorName: error?.name,
      message: String(error?.message ?? error).slice(0, 300),
    };
  }
  evidence.testPassed = testPassed;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    `${evidenceDir}/report.json`,
    JSON.stringify(evidence, null, 2),
  );
  report("result", {
    testPassed,
    cleanupPassed: evidence.cleanup.passed,
    evidenceDir,
  });
  await sql.end();
  process.exitCode = testPassed && evidence.cleanup.passed ? 0 : 1;
}
