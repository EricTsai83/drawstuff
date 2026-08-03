import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.DRAWSTUFF_TEST_BASE_URL ?? "http://127.0.0.1:3107";
const safeDatabaseUrl =
  "postgres://drawstuff:drawstuff@127.0.0.1:65432/drawstuff_e2e";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  workers: 1,
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
      name: "webkit-mobile",
      use: {
        ...devices["iPhone 12"],
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    // Build + start so the server always serves the current sources.
    command: "pnpm preview --port 3107",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      POSTGRES_URL: safeDatabaseUrl,
      POSTGRES_URL_NON_POOLING: safeDatabaseUrl,
      POSTGRES_URL_NO_SSL: safeDatabaseUrl,
      POSTGRES_PRISMA_URL: safeDatabaseUrl,
      POSTGRES_HOST: "127.0.0.1",
      POSTGRES_USER: "drawstuff",
      POSTGRES_PASSWORD: "drawstuff",
      POSTGRES_DATABASE: "drawstuff_e2e",
      NEXT_PUBLIC_BASE_URL: baseURL,
    },
  },
});
