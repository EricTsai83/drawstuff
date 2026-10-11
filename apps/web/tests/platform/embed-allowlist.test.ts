import { describe, expect, it } from "vitest";

import {
  createEmbedUrlValidator,
  EMBED_DENIED_DOMAINS,
  EMBED_FRAME_SRC_HOSTS,
} from "@/config/embed-allowlist";

describe("createEmbedUrlValidator", () => {
  it("rejects srcdoc-script embed domains instead of deferring to upstream", () => {
    const validate = createEmbedUrlValidator([]);

    // 這些 embed 需要外部 script 以頁面同源權限執行（room key 所在 origin），
    // CSP 不放行其 script origin，validator 必須同步拒絕（threat model T16）。
    expect(validate("https://twitter.com/user/status/123")).toBe(false);
    expect(validate("https://www.twitter.com/user/status/123")).toBe(false);
    expect(validate("https://x.com/user/status/123")).toBe(false);
    expect(validate("https://reddit.com/r/foo/comments/1/bar")).toBe(false);
    expect(validate("https://www.reddit.com/r/foo/comments/1/bar")).toBe(false);
    expect(validate("https://gist.github.com/user/abc123")).toBe(false);
  });

  it("still defers pure-iframe embed domains to upstream", () => {
    const validate = createEmbedUrlValidator([]);

    expect(validate("https://www.youtube.com/watch?v=abc")).toBeUndefined();
    expect(validate("https://player.vimeo.com/video/1")).toBeUndefined();
    expect(validate("https://val.town/v/user/thing")).toBeUndefined();
  });

  it("lets an extra-domain entry win only when it is not denied", () => {
    const validate = createEmbedUrlValidator(["twitter.com", "example.com"]);

    // 封鎖名單優先於補充名單：手動加回被封鎖的網域不得放行。
    expect(validate("https://twitter.com/user/status/123")).toBe(false);
    expect(validate("https://example.com/board/1")).toBe(true);
  });

  it("pins the CSP frame-src host list to https host sources only", () => {
    for (const host of EMBED_FRAME_SRC_HOSTS) {
      expect(host).toMatch(/^https:\/\/[a-z0-9*][a-z0-9.*-]*$/);
      expect(host).not.toBe("https://*");
    }
    // 封鎖網域不得出現在 frame-src 決策裡。
    for (const denied of EMBED_DENIED_DOMAINS) {
      for (const host of EMBED_FRAME_SRC_HOSTS) {
        expect(host).not.toContain(denied);
      }
    }
  });
  it("allows an exact hostname match", () => {
    const validate = createEmbedUrlValidator(["example.com"]);

    expect(validate("https://example.com/board/1")).toBe(true);
    expect(validate("http://EXAMPLE.com")).toBe(true);
  });

  it("allows subdomains for a wildcard entry", () => {
    const validate = createEmbedUrlValidator(["*.example.com"]);

    expect(validate("https://docs.example.com/page")).toBe(true);
    expect(validate("https://a.b.example.com")).toBe(true);
  });

  it("does not treat a wildcard entry as its apex domain", () => {
    const validate = createEmbedUrlValidator(["*.example.com"]);

    expect(validate("https://example.com")).toBeUndefined();
    expect(validate("https://notexample.com")).toBeUndefined();
  });

  it("defers to upstream for a non-listed domain instead of rejecting", () => {
    const validate = createEmbedUrlValidator(["example.com"]);

    // undefined（而非 false）才會讓 upstream 內建白名單繼續生效。
    expect(validate("https://www.youtube.com/watch?v=abc")).toBeUndefined();
  });

  it("defers to upstream for an unparseable url", () => {
    const validate = createEmbedUrlValidator(["example.com"]);

    expect(validate("not a url")).toBeUndefined();
    expect(validate("")).toBeUndefined();
    expect(validate("mailto:someone@example.com")).toBeUndefined();
  });

  it("always defers to upstream when the list is empty", () => {
    const validate = createEmbedUrlValidator([]);

    expect(validate("https://example.com")).toBeUndefined();
    expect(validate("https://www.youtube.com/watch?v=abc")).toBeUndefined();
  });

  it("ignores blank entries and surrounding whitespace", () => {
    const validate = createEmbedUrlValidator([" ", "  Example.COM  "]);

    expect(validate("https://example.com")).toBe(true);
  });

  it("drops a malformed bare wildcard instead of failing open", () => {
    const validate = createEmbedUrlValidator(["*."]);

    // `*.` 一度會變成 suffix "."，讓任何帶尾點的 hostname 全部放行。
    expect(validate("https://attacker.com./")).toBeUndefined();
    expect(validate("https://attacker.com/")).toBeUndefined();
  });

  it("rejects entries containing URL syntax instead of extracting a hostname", () => {
    const validate = createEmbedUrlValidator([
      "example.com/evil",
      "example.com:8443",
      "user@example.com",
      "example.com?q=1",
      "example.com#frag",
      "*.com/evil",
      "https://example.com",
    ]);

    // 這些手誤一度會被 URL parser 截成合法 hostname（`*.com/evil` 甚至
    // 會放行整個 .com TLD）；現在一律整條拒絕，不做部分萃取。
    expect(validate("https://example.com/anything")).toBeUndefined();
    expect(validate("https://sub.com/")).toBeUndefined();
    expect(validate("https://anything.com/")).toBeUndefined();
  });

  it("matches a unicode IDN entry against its punycode hostname", () => {
    const validate = createEmbedUrlValidator(["例子.测试", "*.例子.测试"]);

    expect(validate("https://xn--fsqu00a.xn--0zwm56d/page")).toBe(true);
    expect(validate("https://例子.测试/page")).toBe(true);
    expect(validate("https://docs.例子.测试/page")).toBe(true);
  });

  it("treats a DNS-equivalent trailing-dot hostname as the same host", () => {
    const validate = createEmbedUrlValidator(["example.com", "*.example.com"]);

    expect(validate("https://example.com./x")).toBe(true);
    expect(validate("https://docs.example.com./x")).toBe(true);
    // 尾點條目也會被 canonical 化。
    expect(
      createEmbedUrlValidator(["example.com."])("https://example.com"),
    ).toBe(true);
  });
});
