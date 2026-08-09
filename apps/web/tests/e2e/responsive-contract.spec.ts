import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  activateByKeyboard,
  expectNoDocumentHorizontalOverflow,
} from "../support/responsive";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1728, height: 1080 },
] as const;

test("keeps Canvas actions reachable and mutually exclusive across the responsive contract", async ({
  page,
}) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator(".excalidraw")).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page);

    const desktopActions = page.getByTestId("canvas-product-actions");
    const usesDesktopPresentation = await desktopActions
      .isVisible()
      .catch(() => false);
    const outerSceneName = page.getByTestId("scene-name-trigger");

    if (usesDesktopPresentation) {
      await expect(
        page.getByRole("button", { name: "Collaborate" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
      await expect(outerSceneName).toBeVisible();
      await expect(page.getByTestId("storage-usage")).toBeVisible();
    } else {
      await expect(desktopActions).toHaveCount(0);
      await expect(outerSceneName).toBeHidden();
      await expect(page.getByTestId("storage-usage")).toHaveCount(0);
    }

    const mainMenuTrigger = page.getByTestId("main-menu-trigger");
    await activateByKeyboard(mainMenuTrigger);
    const mainMenu = page.getByTestId("dropdown-menu");
    const menuSceneTitle = page.getByTestId("main-menu-scene-title");
    const menuRename = mainMenu.getByText("Rename scene", { exact: true });
    const menuCollaboration = mainMenu.getByRole("button", {
      name: /Live collaboration/,
    });
    const menuShare = mainMenu.getByRole("button", {
      name: "Create shareable link",
    });

    if (usesDesktopPresentation) {
      await expect(menuSceneTitle).toHaveCount(0);
      await expect(menuRename).toHaveCount(0);
      await expect(menuCollaboration).toHaveCount(0);
      await expect(menuShare).toHaveCount(0);
      await expect(mainMenu.getByTestId("storage-usage")).toHaveCount(0);
    } else {
      await expect(menuSceneTitle).toBeVisible();
      await expect(menuRename).toBeVisible();
      await expect(menuCollaboration).toBeVisible();
      await expect(menuShare).toBeVisible();
      await expect(mainMenu.getByTestId("storage-usage")).toBeVisible();
    }

    await expect(page.getByTestId("storage-usage")).toHaveCount(1);
    await page.keyboard.press("Escape");
  }
});

test("keeps the compact collaboration workflow within a 320px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByTestId("main-menu-trigger").click();
  await page
    .getByTestId("dropdown-menu")
    .getByRole("button", { name: /Live collaboration/ })
    .click();

  const dialog = page.getByRole("dialog", { name: "Live collaboration" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(288);
  await expectNoDocumentHorizontalOverflow(page);

  const results = await new AxeBuilder({ page })
    .include("[role=dialog]")
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  expect(blocking).toEqual([]);
});
