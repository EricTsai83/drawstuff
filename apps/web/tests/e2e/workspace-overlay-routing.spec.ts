import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
  await page.locator("html").evaluate((element) => {
    element.dataset.recoveryDocument = "original";
  });
  await page.getByRole("link", { name: "Open dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByText("Sign in required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-recovery-document",
    "original",
  );
});

// Only the browser session is faked to expose the real Canvas Dashboard links.
// Server routes remain anonymous; these tests exercise navigation and chrome,
// without depending on a database or an OAuth login.
async function prepareCanvas(page: Page) {
  const timestamp = new Date().toISOString();
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "overlay-session",
          token: "overlay-test-token",
          userId: "overlay-user",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        user: {
          id: "overlay-user",
          name: "Overlay test",
          email: "overlay@example.test",
          emailVerified: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".excalidraw")).toBeVisible();
}

async function openDashboard(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1080) {
    await page.getByTestId("main-menu-trigger").tap();
    await page.getByRole("link", { name: "Open dashboard" }).tap();
  } else {
    await page.getByRole("button", { name: "Open dashboard" }).click();
  }
}

test("clicking outside the modal panel closes the overlay to the Canvas", async ({
  page,
}) => {
  await prepareCanvas(page);
  await openDashboard(page);
  await expect(page.getByRole("dialog", { name: "Dashboard" })).toBeVisible();

  await page.locator('[data-slot="dialog-viewport"]').click({
    position: { x: 4, y: 4 },
  });

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("soft Dashboard navigation, Back, Forward and Escape preserve the Canvas instance", async ({
  page,
}) => {
  await prepareCanvas(page);
  const canvasRoot = page.locator(".excalidraw");
  await expect(canvasRoot).toHaveCount(1);
  await canvasRoot.evaluate((element) => {
    element.setAttribute("data-workspace-routing-instance", "preserved");
  });

  await openDashboard(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  const dashboardDialog = page.getByRole("dialog", { name: "Dashboard" });
  await expect(dashboardDialog).toBeVisible();
  const dashboardViewport = page.locator('[data-slot="dialog-viewport"]', {
    has: dashboardDialog,
  });
  const dashboardHeader = dashboardDialog.locator(
    '[data-slot="dialog-header"]',
  );
  const dashboardBody = dashboardDialog.locator("[data-route-overlay-body]");
  await expect(dashboardViewport).toBeVisible();
  // Layout assertions must observe the final frame of the dialog zoom animation.
  await expect(dashboardDialog).toHaveCSS("opacity", "1");

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Dashboard overlay dimensions are unavailable");
  }
  const dialogLayout = await dashboardDialog.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      display: style.display,
      height: Number.parseFloat(style.height),
      marginTop: Number.parseFloat(style.marginTop),
      maxHeight: style.maxHeight,
      width: Number.parseFloat(style.width),
    };
  });
  expect(dialogLayout.display).toBe("flex");
  expect(dialogLayout.width).toBeCloseTo(viewport.width * 0.8, 0);
  expect(dialogLayout.height).toBeCloseTo(viewport.height - 64, 0);
  expect(dialogLayout.marginTop).toBeCloseTo(32, 0);
  expect(
    viewport.height - (dialogLayout.marginTop + dialogLayout.height),
  ).toBeCloseTo(32, 0);
  expect(dialogLayout.maxHeight).toBe("none");
  const headerLayout = await dashboardHeader.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      paddingBottom: Number.parseFloat(
        window.getComputedStyle(element).paddingBottom,
      ),
      position: window.getComputedStyle(element).position,
    };
  });
  expect(headerLayout.paddingBottom).toBeCloseTo(
    viewport.width >= 640 ? 32 : 24,
    0,
  );
  expect(headerLayout.position).toBe("static");
  await expect
    .poll(() =>
      dashboardDialog.evaluate((element) => {
        const header = element.querySelector('[data-slot="dialog-header"]');
        const body = element.querySelector("[data-route-overlay-body]");
        if (!header || !body) return null;

        const dialogRect = element.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        return {
          bodyStartsAfterHeader:
            Math.abs(bodyRect.top - headerRect.bottom) < 0.5,
          bodyFillsRemainingHeight:
            Math.abs(
              bodyRect.height - (dialogRect.height - headerRect.height),
            ) < 0.5,
        };
      }),
    )
    .toEqual({
      bodyStartsAfterHeader: true,
      bodyFillsRemainingHeight: true,
    });
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
        const body = element.querySelector("[data-route-overlay-body]");
        return {
          hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          overscrollBehavior: style.overscrollBehavior,
          popupOverflowY: popup
            ? window.getComputedStyle(popup).overflowY
            : null,
          bodyOverflowY: body ? window.getComputedStyle(body).overflowY : null,
        };
      }),
    )
    .toEqual({
      hasHorizontalOverflow: false,
      overflowX: "hidden",
      overflowY: "auto",
      overscrollBehavior: "contain",
      popupOverflowY: "visible",
      bodyOverflowY: "visible",
    });

  await dashboardBody.evaluate((element, height) => {
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
      dashboardHeader.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    )
    .toBeCloseTo(headerLayout.height, 0);
  await expect
    .poll(() =>
      dashboardViewport.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      dashboardBody.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(false);
  const headerTopBeforeScroll = await dashboardHeader.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await dashboardViewport.evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect
    .poll(() => dashboardViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      dashboardHeader.evaluate(
        (element) => element.getBoundingClientRect().top,
      ),
    )
    .toBeLessThan(headerTopBeforeScroll - 50);
  await dashboardViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await dashboardDialog
    .locator('[data-overlay-height-probe="true"]')
    .evaluate((element) => element.remove());

  await expect(canvasRoot).toHaveAttribute(
    "data-workspace-routing-instance",
    "preserved",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(canvasRoot).toHaveAttribute(
    "data-workspace-routing-instance",
    "preserved",
  );

  await page.goForward();
  await expect(page.getByRole("dialog", { name: "Dashboard" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
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
