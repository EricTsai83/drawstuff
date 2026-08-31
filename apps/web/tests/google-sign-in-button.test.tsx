import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signInWithGoogle, toastError } = vi.hoisted(() => ({
  signInWithGoogle: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/auth/client", () => ({ signInWithGoogle }));

vi.mock("sonner", () => ({
  toast: { error: toastError },
}));

vi.mock("@/hooks/use-app-i18n", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { createAppTranslate } = await import("@/lib/i18n");
  return {
    useAppI18n: () => ({ langCode: "en", t: createAppTranslate(en) }),
  };
});

import { GoogleSignInButton } from "@/components/google-sign-in-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<GoogleSignInButton />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("GoogleSignInButton", () => {
  it("reports a failed sign-in and restores the button", async () => {
    let rejectSignIn: (error: Error) => void = () => undefined;
    signInWithGoogle.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSignIn = reject;
        }),
    );

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    act(() => button?.click());
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.textContent).toContain("Connecting");

    await act(async () => {
      rejectSignIn(new Error("misconfigured auth origin"));
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith(
      "Unable to connect to Google. Check your connection and try again.",
    );
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-busy")).toBe("false");
    expect(button?.textContent).toContain("Continue with Google");
  });

  it("restores the button if navigation does not replace the page", async () => {
    signInWithGoogle.mockResolvedValue(undefined);
    const button = container.querySelector("button");

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(false);
  });
});
