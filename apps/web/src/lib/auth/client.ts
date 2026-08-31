import { createAuthClient } from "better-auth/react"; // make sure to import from better-auth/react

export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  // baseURL: "http://localhost:3000",
});

const SIGN_IN_TIMEOUT_MS = 15_000;

class GoogleSignInError extends Error {
  constructor(
    readonly code: "request-failed" | "timeout",
    options?: ErrorOptions,
  ) {
    super(
      code === "timeout"
        ? "Google sign-in initialization timed out."
        : "Google sign-in initialization failed.",
      options,
    );
    this.name = "GoogleSignInError";
  }
}

export const signInWithGoogle = async (): Promise<void> => {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(
    () => abortController.abort(),
    SIGN_IN_TIMEOUT_MS,
  );

  try {
    const result = await authClient.signIn.social(
      {
        provider: "google",
        callbackURL: "/",
      },
      { signal: abortController.signal },
    );

    if (result.error) {
      throw new GoogleSignInError(
        abortController.signal.aborted ? "timeout" : "request-failed",
        {
          cause: result.error,
        },
      );
    }
  } catch (error) {
    if (error instanceof GoogleSignInError) throw error;

    throw new GoogleSignInError(
      abortController.signal.aborted ? "timeout" : "request-failed",
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
};
