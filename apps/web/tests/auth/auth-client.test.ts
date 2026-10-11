// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { socialSignIn } = vi.hoisted(() => ({
  socialSignIn: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: { social: socialSignIn },
  }),
}));

import { signInWithGoogle } from "@/lib/auth/client";

describe("signInWithGoogle", () => {
  beforeEach(() => {
    socialSignIn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when Better Auth starts the redirect", async () => {
    socialSignIn.mockResolvedValue({
      data: { redirect: true, url: "https://accounts.google.com" },
      error: null,
    });

    await expect(signInWithGoogle()).resolves.toBeUndefined();
    expect(socialSignIn).toHaveBeenCalledWith(
      { provider: "google", callbackURL: "/" },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
  });

  it("returns to the page that asked, without its fragment", async () => {
    socialSignIn.mockResolvedValue({ data: { redirect: true }, error: null });
    window.history.replaceState(null, "", "/?collab-room=room-a#collab-key=k");
    await signInWithGoogle();
    expect(socialSignIn).toHaveBeenLastCalledWith(
      { provider: "google", callbackURL: "/?collab-room=room-a" },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    // The login page itself is not somewhere to come back to.
    window.history.replaceState(null, "", "/login");
    await signInWithGoogle();
    expect(socialSignIn).toHaveBeenLastCalledWith(
      { provider: "google", callbackURL: "/" },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    window.history.replaceState(null, "", "/");
  });

  it("turns Better Auth error results into a typed failure", async () => {
    const providerError = { message: "Invalid callback URL", status: 403 };
    socialSignIn.mockResolvedValue({ data: null, error: providerError });

    await expect(signInWithGoogle()).rejects.toMatchObject({
      name: "GoogleSignInError",
      code: "request-failed",
      cause: providerError,
    });
  });

  it("normalizes rejected requests without leaking provider details", async () => {
    socialSignIn.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(signInWithGoogle()).rejects.toMatchObject({
      name: "GoogleSignInError",
      code: "request-failed",
    });
  });

  it("aborts a request that never settles", async () => {
    vi.useFakeTimers();
    socialSignIn.mockImplementation(
      (_input: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );

    const rejection = expect(signInWithGoogle()).rejects.toMatchObject({
      name: "GoogleSignInError",
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });
});
