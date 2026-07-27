// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validEnv = {
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "https://drawstuff.test",
  CLEANUP_OWNER_EMAIL: "owner@drawstuff.test",
  CRON_SECRET: "cron-secret",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  NEXT_PUBLIC_BASE_URL: "https://drawstuff.test",
  NODE_ENV: "test",
  POSTGRES_DATABASE: "drawstuff",
  POSTGRES_HOST: "db.drawstuff.test",
  POSTGRES_PASSWORD: "postgres-password",
  POSTGRES_PRISMA_URL: "https://db.drawstuff.test/prisma",
  POSTGRES_URL: "https://db.drawstuff.test/pool",
  POSTGRES_URL_NON_POOLING: "https://db.drawstuff.test/direct",
  POSTGRES_URL_NO_SSL: "https://db.drawstuff.test/no-ssl",
  POSTGRES_USER: "postgres",
  UPLOADTHING_TOKEN: "uploadthing-token",
} as const;

describe("environment parsing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SKIP_ENV_VALIDATION", "");
    for (const [name, value] of Object.entries(validEnv)) {
      vi.stubEnv(name, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the complete server and client environment", async () => {
    const { env } = await import("@/env");

    expect(env.POSTGRES_DATABASE).toBe("drawstuff");
    expect(env.NEXT_PUBLIC_BASE_URL).toBe("https://drawstuff.test");
  });

  it("rejects an invalid public URL when validation is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "not-a-url");
    vi.resetModules();

    await expect(import("@/env")).rejects.toThrow();
  });
});
