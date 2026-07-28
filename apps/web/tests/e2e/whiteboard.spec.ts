import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/whiteboard-test?fixture=mixed-1k&theme=light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-whiteboard-ready",
    "true",
  );
  expect(errors).toEqual([]);
});

test("exposes deterministic diagnostics without document mutations", async ({
  page,
}) => {
  const diagnostics = await page.evaluate(() =>
    window.__DRAWSTUFF_WHITEBOARD_TEST__?.snapshot(),
  );
  expect(diagnostics?.documentEvents).toBe(0);
  expect(diagnostics?.historyCount).toBe(0);
  expect(diagnostics?.store.elements).toBe(1_000);
});

test("has no critical or serious accessibility violations", async ({
  page,
}) => {
  const results = await new AxeBuilder({ page })
    .disableRules(["aria-roledescription"])
    .analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
  ).toEqual([]);
});

test("keeps mobile controls at least 44 CSS pixels", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile-only geometry gate");
  const controls = await page
    .getByRole("toolbar", { name: "Drawing tools" })
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => getComputedStyle(button).display !== "none")
        .map((button) => {
          const bounds = button.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
    );
  expect(
    controls.every(({ width, height }) => width >= 44 && height >= 44),
  ).toBe(true);
});
