import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("hard navigation renders canonical workspace destinations without a duplicate route dialog", async ({
  page,
}) => {
  for (const destination of ["/dashboard", "/workspaces/new"] as const) {
    await page.goto(destination);
    await expect(page).toHaveURL(
      new RegExp(`${destination.replace("/", "\\/")}$`),
    );
    await expect(page.locator(".excalidraw")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText("Sign in required", { exact: true }),
    ).toBeVisible();
  }
});

test("invalid settings identifiers share the canonical not-found result", async ({
  page,
}) => {
  await page.goto("/workspaces/not-a-uuid/settings");
  await expect(
    page.getByRole("heading", {
      name: "This drawing space does not exist.",
    }),
  ).toBeVisible();
});

test("soft Dashboard navigation, Back, Forward and Escape preserve the Canvas instance", async ({
  page,
}) => {
  await page.goto("/workspaces/not-a-uuid/settings");
  const canvasRoot = page.locator(".excalidraw");
  await expect(canvasRoot).toHaveCount(1);
  await canvasRoot.evaluate((element) => {
    element.setAttribute("data-workspace-routing-instance", "preserved");
  });

  await page.getByRole("link", { name: "Open dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const dashboardDialog = page.getByRole("dialog", { name: "Dashboard" });
  await expect(dashboardDialog).toBeVisible();

  const viewport = page.viewportSize();
  const dialogBox = await dashboardDialog.boundingBox();
  if (!viewport || !dialogBox) {
    throw new Error("Dashboard overlay dimensions are unavailable");
  }
  expect(dialogBox.width).toBeGreaterThan(viewport.width * 0.75);
  expect(dialogBox.width).toBeLessThan(viewport.width * 0.85);
  expect(dialogBox.height).toBeGreaterThan(viewport.height * 0.9);
  await expect(canvasRoot).toHaveAttribute(
    "data-workspace-routing-instance",
    "preserved",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/workspaces\/not-a-uuid\/settings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(canvasRoot).toHaveAttribute(
    "data-workspace-routing-instance",
    "preserved",
  );

  await page.goForward();
  await expect(page.getByRole("dialog", { name: "Dashboard" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/workspaces\/not-a-uuid\/settings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(canvasRoot).toHaveAttribute(
    "data-workspace-routing-instance",
    "preserved",
  );
});

test("canonical create page has no serious or critical accessibility violations", async ({
  page,
}) => {
  await page.goto("/workspaces/new");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  expect(blocking).toEqual([]);
});
