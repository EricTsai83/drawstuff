import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

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

test("switches language by pointer and refreshes tunneled editor copy", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("i18nextLng") === null) {
      localStorage.setItem("i18nextLng", "zh-TW");
    }
  });
  await page.goto("/");

  await expect(page.getByRole("region", { name: "形狀" })).toBeVisible();
  await activate(page.getByTestId("main-menu-trigger"));

  const languageSelector = page.getByRole("combobox");
  const mainMenu = page.getByTestId("dropdown-menu");
  await expect(languageSelector).toHaveAccessibleName("選擇語言");
  await expect(languageSelector).toHaveText("繁體中文");
  await activate(languageSelector);
  await activate(page.getByRole("option", { name: "English" }));

  await expect(mainMenu).toBeVisible();
  await expect(languageSelector).toHaveAttribute("aria-expanded", "false");
  await expect(languageSelector).toHaveAccessibleName("Select language");
  await expect(languageSelector).toHaveText("English");
  await expect(page.getByRole("region", { name: "Shapes" })).toBeVisible();
  await expect(
    page.getByText("Draw, collaborate, and share", { exact: true }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= 728) {
    await expect(
      page.getByText("Pick a tool & Start drawing!", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Shortcuts & help", { exact: true }),
    ).toBeVisible();
  }
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("i18nextLng")))
    .toBe("en");

  await activate(languageSelector);
  await expect(languageSelector).toHaveAttribute("aria-expanded", "true");
  await activate(mainMenu.getByText("Help", { exact: true }));
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Help", exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Shapes" })).toBeVisible();
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

async function activate(locator: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) {
    await locator.tap();
    return;
  }
  await locator.click();
}
