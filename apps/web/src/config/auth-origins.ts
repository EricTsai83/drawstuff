type AuthOriginsInput = {
  betterAuthUrl: string;
  publicBaseUrl: string;
  deploymentEnvironment?: "development" | "preview" | "production";
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "0.0.0.0", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return true;
  }

  const [firstOctet] = hostname.split(".");
  return firstOctet === "127";
}

function parseOrigin(name: string, value: string): URL {
  const url = new URL(value);
  const hasNonOriginParts =
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "";

  if (hasNonOriginParts) {
    throw new Error(
      `[auth config] ${name} must contain only an origin, for example https://draw.example.com.`,
    );
  }

  return url;
}

/**
 * Rejects auth origins that would produce unusable OAuth callbacks.
 *
 * Vercel preview deployments may legitimately use generated HTTPS hosts, so
 * the loopback/HTTPS gate is intentionally limited to the production target.
 * Origin equality is universal: links and OAuth callbacks must describe the
 * same public application regardless of environment.
 */
export function validateAuthOrigins(input: AuthOriginsInput): void {
  const authUrl = parseOrigin("BETTER_AUTH_URL", input.betterAuthUrl);
  const publicUrl = parseOrigin("NEXT_PUBLIC_BASE_URL", input.publicBaseUrl);

  if (authUrl.origin !== publicUrl.origin) {
    throw new Error(
      "[auth config] BETTER_AUTH_URL and NEXT_PUBLIC_BASE_URL must use the same origin.",
    );
  }

  if (input.deploymentEnvironment !== "production") return;

  if (authUrl.protocol !== "https:") {
    throw new Error(
      "[auth config] BETTER_AUTH_URL must use HTTPS in the production deployment.",
    );
  }

  if (isLoopbackHostname(authUrl.hostname)) {
    throw new Error(
      "[auth config] BETTER_AUTH_URL cannot use a loopback host in the production deployment.",
    );
  }
}
