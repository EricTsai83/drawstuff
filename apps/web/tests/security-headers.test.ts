import { describe, expect, it } from "vitest";

import { EMBED_FRAME_SRC_HOSTS } from "@/config/embed-allowlist";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  CSP_REPORT_ONLY,
  deriveUploadThingAppId,
  type SecurityHeadersInput,
} from "@/config/security-headers";

// 有效的 UploadThing token：base64(JSON)，appId 為 "abc123"。
const VALID_TOKEN = Buffer.from(
  JSON.stringify({ apiKey: "sk_test", appId: "abc123", regions: ["sea1"] }),
).toString("base64");

const PROD_INPUT: SecurityHeadersInput = {
  isDev: false,
  collabGatewayUrl: "https://relay.example.com",
  uploadThingToken: VALID_TOKEN,
  allowIncompleteEnv: false,
};

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("buildContentSecurityPolicy", () => {
  it("emits a connect-src exactly equal to the approved allowlist", () => {
    const csp = buildContentSecurityPolicy(PROD_INPUT);

    // 每一項都有觸發點（plan 16 盤點表）；多一項是出口、少一項是回歸。
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' wss://relay.example.com " +
        "https://*.ingest.uploadthing.com https://abc123.ufs.sh " +
        "https://libraries.excalidraw.com",
    );
  });

  it("derives the gateway WebSocket origin from COLLAB_CONTROL_URL", () => {
    const csp = buildContentSecurityPolicy({
      ...PROD_INPUT,
      collabGatewayUrl: "https://relay.example.com/v1/control?x=1",
    });

    expect(directive(csp, "connect-src")).toContain("wss://relay.example.com");
    expect(csp).not.toContain("/socket/path");
  });

  it("never emits wildcard-origin or scheme-only sources", () => {
    const sources = buildContentSecurityPolicy(PROD_INPUT)
      .split(";")
      .flatMap((part) => part.trim().split(" ").slice(1));

    // 唯二核准的 host 萬用條目；其餘不得出現 `*`、`https:`、`*.ufs.sh` 等萬用值。
    const approvedWildcards = new Set([
      "https://*.ingest.uploadthing.com",
      "https://*.simplepdf.eu",
    ]);
    for (const source of sources) {
      if (approvedWildcards.has(source)) continue;
      expect(source, `wildcard-ish CSP source: ${source}`).not.toContain("*");
      expect(source).not.toBe("https:");
      expect(source).not.toBe("http:");
    }
    expect(buildContentSecurityPolicy(PROD_INPUT)).not.toContain("*.ufs.sh");
  });

  it("does not include the server-only UploadThing presign endpoint", () => {
    expect(buildContentSecurityPolicy(PROD_INPUT)).not.toContain(
      "api.uploadthing.com",
    );
  });

  it("locks down the injection-surface directives", () => {
    const csp = buildContentSecurityPolicy(PROD_INPUT);

    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "worker-src")).toBe("worker-src 'self'");
  });

  it("keeps frame-src exactly equal to the embed decision", () => {
    const csp = buildContentSecurityPolicy(PROD_INPUT);

    expect(directive(csp, "frame-src")).toBe(
      `frame-src ${EMBED_FRAME_SRC_HOSTS.join(" ")}`,
    );
  });

  it("does not allow external script origins in production", () => {
    const csp = buildContentSecurityPolicy(PROD_INPUT);

    expect(directive(csp, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'",
    );
    // srcdoc embed 的第三方 script（validator 已一併封鎖）不得回流。
    expect(csp).not.toContain("platform.twitter.com");
    expect(csp).not.toContain("embed.reddit.com");
  });

  it("keeps esm.sh out of every directive (self-hosted excalidraw assets)", () => {
    expect(buildContentSecurityPolicy(PROD_INPUT)).not.toContain("esm.sh");
    expect(
      buildContentSecurityPolicy({ ...PROD_INPUT, isDev: true }),
    ).not.toContain("esm.sh");
  });

  it("keeps dev-only relaxations out of the production policy", () => {
    const prod = buildContentSecurityPolicy(PROD_INPUT);
    const dev = buildContentSecurityPolicy({ ...PROD_INPUT, isDev: true });

    expect(prod).not.toContain("unpkg.com");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("ws://");

    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "script-src")).toContain("unpkg.com");
    expect(directive(dev, "connect-src")).toContain("ws://127.0.0.1:*");
  });

  it("has no violation-report outlet", () => {
    const csp = buildContentSecurityPolicy(PROD_INPUT);

    // 違規報告含 URL，而 fragment 是金鑰載體；不為報告新增外部出口。
    expect(csp).not.toContain("report-uri");
    expect(csp).not.toContain("report-to");
  });

  it("fails the build instead of widening when UPLOADTHING_TOKEN is unusable", () => {
    expect(() =>
      buildContentSecurityPolicy({ ...PROD_INPUT, uploadThingToken: "nope" }),
    ).toThrow(/UPLOADTHING_TOKEN/);
    expect(() =>
      buildContentSecurityPolicy({
        ...PROD_INPUT,
        uploadThingToken: undefined,
      }),
    ).toThrow(/UPLOADTHING_TOKEN/);
  });

  it("fails the build when COLLAB_CONTROL_URL is unusable", () => {
    expect(() =>
      buildContentSecurityPolicy({
        ...PROD_INPUT,
        collabGatewayUrl: undefined,
      }),
    ).toThrow(/COLLAB_CONTROL_URL/);
    expect(() =>
      buildContentSecurityPolicy({
        ...PROD_INPUT,
        collabGatewayUrl: "not a url",
      }),
    ).toThrow(/COLLAB_CONTROL_URL/);
  });

  it("fails the build on a parseable but wildcarded or non-HTTP gateway URL", () => {
    // `new URL("https://*.example.com")` 可解析；不驗證會輸出萬用 origin。
    expect(() =>
      buildContentSecurityPolicy({
        ...PROD_INPUT,
        collabGatewayUrl: "https://*.example.com",
      }),
    ).toThrow(/COLLAB_CONTROL_URL/);
    expect(() =>
      buildContentSecurityPolicy({
        ...PROD_INPUT,
        collabGatewayUrl: "wss://relay.example.com",
      }),
    ).toThrow(/COLLAB_CONTROL_URL/);
  });

  it("fails the build on a parseable token whose appId is not a DNS-safe label", () => {
    const tokenWithAppId = (appId: string) =>
      Buffer.from(JSON.stringify({ apiKey: "sk", appId })).toString("base64");

    // `{"appId":"*"}` 不驗證會讓 connect-src 輸出被禁止的 `https://*.ufs.sh`。
    for (const appId of ["*", "a b", "a;c", "evil.com", "a.ufs.sh 'self'"]) {
      expect(() =>
        buildContentSecurityPolicy({
          ...PROD_INPUT,
          uploadThingToken: tokenWithAppId(appId),
        }),
      ).toThrow(/UPLOADTHING_TOKEN/);
    }
  });

  it("omits missing sources without widening on SKIP_ENV_VALIDATION builds", () => {
    const csp = buildContentSecurityPolicy({
      isDev: false,
      collabGatewayUrl: undefined,
      uploadThingToken: "something-cool",
      allowIncompleteEnv: true,
    });

    // CI（SKIP_ENV_VALIDATION）產物不部署：缺的來源直接省略，絕不放寬。
    expect(csp).not.toContain("ufs.sh");
    expect(csp).not.toContain("ws://");
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://*.ingest.uploadthing.com " +
        "https://libraries.excalidraw.com",
    );
  });
});

describe("buildSecurityHeaders", () => {
  it("carries the CSP under the name matching the rollout phase", () => {
    const headers = buildSecurityHeaders(PROD_INPUT);
    const cspHeader = headers.find((header) =>
      header.key.startsWith("Content-Security-Policy"),
    );

    expect(cspHeader?.key).toBe(
      CSP_REPORT_ONLY
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
    );
    expect(cspHeader?.value).toBe(buildContentSecurityPolicy(PROD_INPUT));
  });

  it("sets the supporting hardening headers", () => {
    const headers = Object.fromEntries(
      buildSecurityHeaders(PROD_INPUT).map(({ key, value }) => [key, value]),
    );

    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});

describe("deriveUploadThingAppId", () => {
  it("extracts the appId from a valid token", () => {
    expect(deriveUploadThingAppId(VALID_TOKEN)).toBe("abc123");
  });

  it("returns undefined for a missing or malformed token", () => {
    expect(deriveUploadThingAppId(undefined)).toBeUndefined();
    expect(deriveUploadThingAppId("")).toBeUndefined();
    expect(deriveUploadThingAppId("something-cool")).toBeUndefined();
    expect(
      deriveUploadThingAppId(
        Buffer.from(JSON.stringify({ appId: "" })).toString("base64"),
      ),
    ).toBeUndefined();
  });
});
