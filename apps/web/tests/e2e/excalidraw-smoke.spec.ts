import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("keeps the restored official Excalidraw composition", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect(page.getByRole("region", { name: "Shapes" })).toBeVisible();
  await expect(page.getByTestId("main-menu-trigger")).toHaveAccessibleName(
    "Menu",
  );
  await expect(page.locator("canvas").first()).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= 728) {
    await expect(page.getByRole("button", { name: /^Untitled/ })).toBeVisible();
  }
});

test("supports keyboard drawing controls and undo", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();

  await page.keyboard.press("r");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + 100, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 250, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator(".excalidraw")).toBeVisible();
});

test("has no serious or critical automated accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  expect(blocking).toEqual([]);
});
