import { describe, expect, it } from "vitest";

import { validateAuthOrigins } from "@/config/auth-origins";

describe("validateAuthOrigins", () => {
  it("accepts matching HTTPS origins in production", () => {
    expect(() =>
      validateAuthOrigins({
        betterAuthUrl: "https://draw.example.com",
        publicBaseUrl: "https://draw.example.com/",
        deploymentEnvironment: "production",
      }),
    ).not.toThrow();
  });

  it("rejects localhost in the production deployment", () => {
    expect(() =>
      validateAuthOrigins({
        betterAuthUrl: "http://localhost:3000",
        publicBaseUrl: "http://localhost:3000",
        deploymentEnvironment: "production",
      }),
    ).toThrow(/loopback|HTTPS/);
  });

  it("allows matching localhost origins outside production", () => {
    expect(() =>
      validateAuthOrigins({
        betterAuthUrl: "http://localhost:3000",
        publicBaseUrl: "http://localhost:3000",
        deploymentEnvironment: "development",
      }),
    ).not.toThrow();
  });

  it("rejects origins that disagree in any environment", () => {
    expect(() =>
      validateAuthOrigins({
        betterAuthUrl: "https://auth.example.com",
        publicBaseUrl: "https://draw.example.com",
        deploymentEnvironment: "preview",
      }),
    ).toThrow(/same origin/);
  });

  it("rejects paths, credentials, queries, and fragments", () => {
    for (const betterAuthUrl of [
      "https://draw.example.com/api/auth",
      "https://user:pass@draw.example.com",
      "https://draw.example.com?source=env",
      "https://draw.example.com#callback",
    ]) {
      expect(() =>
        validateAuthOrigins({
          betterAuthUrl,
          publicBaseUrl: "https://draw.example.com",
        }),
      ).toThrow(/only an origin/);
    }
  });
});
