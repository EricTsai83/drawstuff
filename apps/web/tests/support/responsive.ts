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

export async function activateByKeyboard(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  await locator.press("Enter");
}
