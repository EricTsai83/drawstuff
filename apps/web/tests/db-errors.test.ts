import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "@/server/db/errors";

function withCode(code: string): Error {
  return Object.assign(new Error("db"), { code });
}

describe("isUniqueViolation", () => {
  it("detects a bare driver error", () => {
    expect(isUniqueViolation(withCode("23505"))).toBe(true);
  });

  it("detects a driver error wrapped as cause", () => {
    expect(
      isUniqueViolation(new Error("query", { cause: withCode("23505") })),
    ).toBe(true);
  });

  it("rejects other codes and non-errors", () => {
    expect(isUniqueViolation(withCode("23503"))).toBe(false);
    expect(
      isUniqueViolation(new Error("x", { cause: { code: "23505" } })),
    ).toBe(false);
    expect(isUniqueViolation({ code: "23505" })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
