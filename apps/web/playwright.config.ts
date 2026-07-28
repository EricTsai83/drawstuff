import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.WHITEBOARD_TEST_BASE_URL ?? "http://127.0.0.1:3107";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1728, height: 1080 },
      },
    },
    {
      name: "chromium-laptop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["iPhone 12"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1728, height: 1080 },
      },
    },
    {
      name: "webkit-laptop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 12"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "NEXT_PUBLIC_WHITEBOARD_TEST_MODE=1 pnpm start --port 3107",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
