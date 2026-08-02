import { expect, test, type Page } from "@playwright/test";

/**
 * Plan 11: two pages in one browser context share a room over the
 * BroadcastChannel POC transport and must converge to the same element
 * semantic digest. Runs on chromium-desktop only: the flow is engine-level
 * and mouse-driven, so one deterministic project keeps it stable.
 */
test.beforeEach(() => {
  test.skip(
    test.info().project.name !== "chromium-desktop",
    "collab POC convergence runs on chromium-desktop only",
  );
});

type SceneElement = {
  id: string;
  version: number;
  isDeleted: boolean;
};

async function sceneSnapshot(page: Page): Promise<string | null> {
  return page.evaluate(
    () => window.__drawstuffCollabPoc?.getSceneSnapshot() ?? null,
  );
}

async function visibleElementCount(page: Page): Promise<number> {
  const snapshot = await sceneSnapshot(page);
  if (snapshot === null) return -1;
  const elements = JSON.parse(snapshot) as SceneElement[];
  return elements.filter((element) => !element.isDeleted).length;
}

async function openCollabPage(
  page: Page,
  room: string,
  user: string,
): Promise<void> {
  await page.goto(`/?collab-room=${room}&collab-user=${user}`);
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(() => sceneSnapshot(page), {
      message: "collab POC runtime should attach its test hook",
    })
    .not.toBeNull();
}

async function drawRectangle(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.bringToFront();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // Click the toolbar radio instead of the "r" shortcut: keyboard shortcuts
  // are unreliable across multiple pages sharing one browser window.
  const rectangleTool = page.getByTestId("toolbar-rectangle");
  // The radio input sits under its ToolIcon label overlay, so the default
  // hit-target check refuses the click; the checked assertion below still
  // guards that the tool actually switched.
  await rectangleTool.click({ force: true });
  await expect(rectangleTool).toBeChecked();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

async function expectConvergence(
  pageA: Page,
  pageB: Page,
  expectedVisibleCount: number,
): Promise<void> {
  await expect
    .poll(() => visibleElementCount(pageA), { timeout: 10_000 })
    .toBe(expectedVisibleCount);
  await expect
    .poll(
      async () => {
        const [snapshotA, snapshotB] = await Promise.all([
          sceneSnapshot(pageA),
          sceneSnapshot(pageB),
        ]);
        return snapshotA !== null && snapshotA === snapshotB;
      },
      {
        message: "both clients should reach the same element semantic digest",
        timeout: 10_000,
      },
    )
    .toBe(true);
}

test("two clients converge and remote edits stay out of local undo", async ({
  page: pageA,
  context,
}) => {
  const room = `e2e-${test.info().testId}-${Date.now()}`;
  await pageA.addInitScript(() => {
    // Start from a clean local scene so the digest only contains what the
    // test draws.
    localStorage.clear();
  });
  await openCollabPage(pageA, room, "alice");

  const pageB = await context.newPage();
  await openCollabPage(pageB, room, "bob");

  // Coordinates stay in the lower canvas half: the welcome-screen hints
  // overlay parts of the upper canvas and swallow pointer events there.
  // Alice draws; Bob must receive the element without touching his canvas.
  await drawRectangle(pageA, { x: 300, y: 700 }, { x: 450, y: 800 });
  await expectConvergence(pageA, pageB, 1);

  // Bob draws a second rectangle; both scenes now hold two elements.
  await drawRectangle(pageB, { x: 700, y: 700 }, { x: 850, y: 800 });
  await expectConvergence(pageA, pageB, 2);

  // Bob's undo removes only his own rectangle, and the deletion syncs.
  await pageB.bringToFront();
  await pageB.getByTestId("button-undo").click();
  await expectConvergence(pageA, pageB, 1);

  // Bob's undo stack must now be empty: Alice's remote rectangle and the
  // synced deletion never became local history entries on Bob's side.
  await expect(pageB.getByTestId("button-undo")).toBeDisabled();
  await expectConvergence(pageA, pageB, 1);

  // Presence: Alice sees Bob's username once his pointer moves.
  await pageB.bringToFront();
  const canvasB = pageB.locator("canvas").first();
  const boxB = await canvasB.boundingBox();
  expect(boxB).not.toBeNull();
  if (boxB) {
    await pageB.mouse.move(boxB.x + 600, boxB.y + 650);
    await pageB.mouse.move(boxB.x + 620, boxB.y + 670, { steps: 3 });
  }
  await expect
    .poll(
      () =>
        pageA.evaluate(
          () => window.__drawstuffCollabPoc?.getCollaboratorUsernames() ?? [],
        ),
      { timeout: 10_000 },
    )
    .toContain("bob");

  await pageB.close();
});
