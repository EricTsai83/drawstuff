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
  const dashboardViewport = page.locator('[data-slot="dialog-viewport"]', {
    has: dashboardDialog,
  });
  await expect(dashboardViewport).toBeVisible();

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Dashboard overlay dimensions are unavailable");
  }
  const dialogLayout = await dashboardDialog.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      height: Number.parseFloat(style.height),
      marginTop: Number.parseFloat(style.marginTop),
      maxHeight: style.maxHeight,
      width: Number.parseFloat(style.width),
    };
  });
  expect(dialogLayout.width).toBeCloseTo(viewport.width * 0.8, 0);
  expect(dialogLayout.height).toBeCloseTo(viewport.height - 64, 0);
  expect(dialogLayout.marginTop).toBeCloseTo(32, 0);
  expect(
    viewport.height - (dialogLayout.marginTop + dialogLayout.height),
  ).toBeCloseTo(32, 0);
  expect(dialogLayout.maxHeight).toBe("none");
  const viewportBox = await dashboardViewport.boundingBox();
  if (!viewportBox) {
    throw new Error("Dashboard scroll viewport dimensions are unavailable");
  }
  expect(viewportBox.x).toBeCloseTo(0, 0);
  expect(viewportBox.x + viewportBox.width).toBeCloseTo(viewport.width, 0);
  await expect
    .poll(() =>
      dashboardViewport.evaluate((element) => {
        const style = window.getComputedStyle(element);
        const popup = element.querySelector('[data-slot="dialog-content"]');
        return {
          hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          overscrollBehavior: style.overscrollBehavior,
          popupOverflowY: popup
            ? window.getComputedStyle(popup).overflowY
            : null,
        };
      }),
    )
    .toEqual({
      hasHorizontalOverflow: false,
      overflowX: "hidden",
      overflowY: "auto",
      overscrollBehavior: "contain",
      popupOverflowY: "visible",
    });

  await dashboardDialog.evaluate((element, height) => {
    const probe = document.createElement("div");
    probe.dataset.overlayHeightProbe = "true";
    probe.style.height = `${height}px`;
    element.append(probe);
  }, viewport.height * 2);
  await expect
    .poll(() => dashboardDialog.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(viewport.height * 2);
  await expect
    .poll(() =>
      dashboardViewport.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await dashboardDialog
    .locator('[data-overlay-height-probe="true"]')
    .evaluate((element) => element.remove());

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
