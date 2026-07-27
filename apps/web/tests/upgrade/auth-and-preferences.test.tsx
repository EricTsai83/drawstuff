import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_CHANGE_EVENT } from "@/lib/events";
import { STORAGE_KEYS } from "@/config/app-constants";

const authMocks = vi.hoisted(() => ({
  social: vi.fn(),
  signOut: vi.fn(),
}));

const themeMocks = vi.hoisted(() => {
  const state: {
    theme: string | undefined;
    resolvedTheme: string | undefined;
  } = {
    theme: "system",
    resolvedTheme: "light",
  };

  return {
    state,
    setTheme: vi.fn(),
  };
});

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: { social: authMocks.social },
    signOut: authMocks.signOut,
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    ...themeMocks.state,
    setTheme: themeMocks.setTheme,
  }),
}));

vi.mock("@/components/whiteboard/language/language-detector", () => ({
  getPreferredLanguage: () => "en",
}));

import { signInWithGoogle, signOut } from "@/lib/auth/client";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { useSyncTheme } from "@/hooks/use-sync-theme";

describe("Google authentication contracts", () => {
  beforeEach(() => {
    authMocks.social.mockReset();
    authMocks.signOut.mockReset();
  });

  it("starts Google sign-in with the editor as callback destination", async () => {
    authMocks.social.mockResolvedValue(undefined);

    await signInWithGoogle();

    expect(authMocks.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
  });

  it("runs the refresh callback after sign-out succeeds", async () => {
    const refresh = vi.fn();
    authMocks.signOut.mockImplementation(
      async (options: {
        fetchOptions: {
          onSuccess: () => void;
        };
      }) => {
        options.fetchOptions.onSuccess();
      },
    );

    await signOut(refresh);

    expect(authMocks.signOut).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("theme and language preferences", () => {
  beforeEach(() => {
    themeMocks.state.theme = "system";
    themeMocks.state.resolvedTheme = "light";
    themeMocks.setTheme.mockReset();
  });

  it("maps the stored theme to the active whiteboard theme and exposes switching", () => {
    themeMocks.state.theme = "dark";
    themeMocks.state.resolvedTheme = "dark";
    const { result } = renderHook(() => useSyncTheme());

    expect(result.current.userChosenTheme).toBe("dark");
    expect(result.current.browserActiveTheme).toBe("dark");

    result.current.setTheme("light");
    expect(themeMocks.setTheme).toHaveBeenCalledWith("light");
  });

  it("uses system and light fallbacks before theme hydration", () => {
    themeMocks.state.theme = undefined;
    themeMocks.state.resolvedTheme = undefined;
    const { result } = renderHook(() => useSyncTheme());

    expect(result.current.userChosenTheme).toBe("system");
    expect(result.current.browserActiveTheme).toBe("light");
  });

  it("persists a language change and broadcasts it to mounted consumers", () => {
    const eventListener = vi.fn();
    window.addEventListener(LANGUAGE_CHANGE_EVENT, eventListener);
    const { result } = renderHook(() => useLanguagePreference());

    act(() => {
      result.current.handleLangCodeChange("zh-TW");
    });

    expect(result.current.langCode).toBe("zh-TW");
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LANGUAGE)).toBe(
      "zh-TW",
    );
    expect(eventListener).toHaveBeenCalledOnce();
    const event = eventListener.mock.calls[0]?.[0] as CustomEvent<{
      langCode: string;
    }>;
    expect(event.detail.langCode).toBe("zh-TW");

    window.removeEventListener(LANGUAGE_CHANGE_EVENT, eventListener);
  });
});
