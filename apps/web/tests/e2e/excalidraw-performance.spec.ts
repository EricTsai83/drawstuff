import { expect, test, type Page } from "@playwright/test";

import { STORAGE_KEYS } from "../../src/config/app-constants";
import { EXCALIDRAW_PERFORMANCE_BUDGETS } from "../support/excalidraw-performance-fixtures";

test("records the desktop editor interaction baseline @performance", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "The memory baseline uses Chromium CDP and one fixed desktop viewport.",
  );

  const navigationStartedAt = performance.now();
  await page.goto("/");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const editorReadyMs = performance.now() - navigationStartedAt;

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.click(box.x + 250, box.y + 250);

  const initialElementCount = await storedElementCount(page);
  await assertDrawUndoRoundTrip(page, box, 0, initialElementCount);

  const interactionDurationsMs: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const startedAt = performance.now();
    await drawRectangle(page, box, index);
    await page.keyboard.press("ControlOrMeta+z");
    interactionDurationsMs.push(performance.now() - startedAt);
  }
  interactionDurationsMs.sort((left, right) => left - right);
  await assertDrawUndoRoundTrip(page, box, 13, initialElementCount);

  const session = await page.context().newCDPSession(page);
  const performanceMetrics = await (async () => {
    try {
      await session.send("Performance.enable");
      return await session.send("Performance.getMetrics");
    } finally {
      await session.detach();
    }
  })();
  const metric = (name: string): number | null =>
    performanceMetrics.metrics.find((candidate) => candidate.name === name)
      ?.value ?? null;
  const result = {
    fixture: "plan-00-editor-interaction-v1",
    viewport: page.viewportSize(),
    editorReadyMs: round(editorReadyMs),
    interactionCount: interactionDurationsMs.length,
    interactionP50Ms: round(
      interactionDurationsMs[Math.floor(interactionDurationsMs.length * 0.5)] ??
        0,
    ),
    interactionP95Ms: round(
      interactionDurationsMs[
        Math.floor(interactionDurationsMs.length * 0.95)
      ] ?? 0,
    ),
    jsHeapUsedBytes: metric("JSHeapUsedSize"),
    domNodes: metric("Nodes"),
    budgetEnforced: process.env.ENFORCE_EXCALIDRAW_PERFORMANCE_BUDGETS === "1",
  };

  await testInfo.attach("performance-baseline.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.info(`PERFORMANCE_BASELINE ${JSON.stringify(result)}`);

  if (result.budgetEnforced) {
    expect(result.interactionP95Ms).toBeLessThanOrEqual(
      EXCALIDRAW_PERFORMANCE_BUDGETS.editorInteractionP95Ms,
    );
  }
});

async function assertDrawUndoRoundTrip(
  page: Page,
  box: { readonly x: number; readonly y: number },
  index: number,
  initialElementCount: number,
): Promise<void> {
  await drawRectangle(page, box, index);
  await expect
    .poll(() => storedElementCount(page))
    .toBe(initialElementCount + 1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => storedElementCount(page)).toBe(initialElementCount);
}

async function drawRectangle(
  page: Page,
  box: { readonly x: number; readonly y: number },
  index: number,
): Promise<void> {
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300 + index * 3, box.y + 300 + index * 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 400 + index * 3, box.y + 370 + index * 2, {
    steps: 3,
  });
  await page.mouse.up();
}

async function storedElementCount(page: Page): Promise<number> {
  return page.evaluate((storageKey) => {
    const rawElements = localStorage.getItem(storageKey);
    if (!rawElements) return 0;
    const elements = JSON.parse(rawElements) as unknown;
    if (!Array.isArray(elements)) return 0;
    return elements.filter(
      (element) =>
        typeof element === "object" &&
        element !== null &&
        "isDeleted" in element &&
        element.isDeleted !== true,
    ).length;
  }, STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
