import { expect, type Locator, type Page } from "@playwright/test";

export async function expectNoDocumentHorizontalOverflow(
  page: Page,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

export async function expectTouchTarget(
  locator: Locator,
  minimum = 44,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "touch target must have a measurable box").not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minimum);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

export async function activateByKeyboard(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  await locator.press("Enter");
}
