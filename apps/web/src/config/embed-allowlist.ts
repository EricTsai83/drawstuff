// Excalidraw 0.18.1 內建約 16 個 embeddable 網域白名單，不在名單內的網址會被拒絕。
// 唯一的公開 escape hatch 是 `validateEmbeddable` prop；本檔案就是專案自管的補充名單。
//
// 由使用者手動維護，支援兩種寫法：
//   1. 完整 hostname：`example.com` 只比對 `example.com` 本身。
//   2. 萬用字元子網域：`*.example.com` 只比對子網域（如 `docs.example.com`），
//      不含 apex（`example.com` 本身要另外列一行）。
//
// 比對一律忽略大小寫與前後空白；不支援 path、port 或 protocol 條件。
export const EXTRA_EMBED_DOMAINS: readonly string[] = [
  // "*.notion.site",
];

// T16（threat model B6）的 embed 決策：upstream 內建白名單中，twitter/x、
// reddit 與 gist.github.com 走 srcdoc iframe 且 `allowSameOrigin`，其外部
// script（platform.twitter.com、embed.reddit.com、gist.github.com）會以與
// 頁面同源的權限執行——room key 就存在於這個 origin 的 JS 記憶體。允許它們
// 等於把第三方 CDN 納入信任邊界，因此在 validator 層明確封鎖，CSP 的
// `script-src` 也不放行任何外部 script origin。比對規則與 upstream 一致：
// hostname 去掉單一前導 `www.` 後精確比對。
export const EMBED_DENIED_DOMAINS: readonly string[] = [
  "twitter.com",
  "x.com",
  "reddit.com",
  "gist.github.com",
];

// CSP `frame-src` 的單一來源（security-headers.ts 直接引用），必須與
// validator 實際放行的 embed 最終 iframe host 一致：
// - upstream 內建白名單（0.18.1）扣除上方封鎖名單；
// - youtube/vimeo/figma/giphy 連結會被 upstream 改寫成固定 embed host，
//   其餘（generic type）沿用貼入的原始 host，因此 apex 與 www 都要列出；
// - `*.simplepdf.eu` 是 upstream 內建的一層子網域萬用條目，原樣保留。
// EXTRA_EMBED_DOMAINS 若新增條目，必須同步把對應 host 加進這份清單。
export const EMBED_FRAME_SRC_HOSTS: readonly string[] = [
  "https://youtube.com",
  "https://www.youtube.com",
  "https://youtu.be",
  "https://www.youtu.be",
  "https://vimeo.com",
  "https://www.vimeo.com",
  "https://player.vimeo.com",
  "https://figma.com",
  "https://www.figma.com",
  "https://link.excalidraw.com",
  "https://www.link.excalidraw.com",
  "https://*.simplepdf.eu",
  "https://stackblitz.com",
  "https://www.stackblitz.com",
  "https://val.town",
  "https://www.val.town",
  "https://giphy.com",
  "https://www.giphy.com",
];

/**
 * 依補充名單建立 `validateEmbeddable` 用的驗證函式。
 *
 * 回傳值：
 * - `false`：hostname 命中 `deniedDomains`（srcdoc-script embed），明確拒絕，
 *   不再交還 upstream；這是 CSP 不放行外部 `script-src` 的對應決策。
 * - `true`：hostname 命中補充名單，直接放行。
 * - `undefined`：交還給 upstream，改用它內建的白名單判斷（YouTube 等維持原行為）。
 */
export function createEmbedUrlValidator(
  domains: readonly string[],
  deniedDomains: readonly string[] = EMBED_DENIED_DOMAINS,
): (url: string) => boolean | undefined {
  const exactHostnames = new Set<string>();
  // 以 `.example.com` 形式保存，方便直接用 suffix 比對子網域。
  const wildcardSuffixes: string[] = [];

  for (const entry of domains) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;

    // 條目一律轉成 canonical hostname（IDNA punycode、去尾點）。
    // 無法 canonical 化的條目直接略過（fail-closed），避免 `*.` 這類
    // 手誤變成過寬的 suffix 而放行任意網域。
    if (normalized.startsWith("*.")) {
      const suffixHost = canonicalizeHostname(normalized.slice(2));
      if (suffixHost) wildcardSuffixes.push(`.${suffixHost}`);
    } else {
      const host = canonicalizeHostname(normalized);
      if (host) exactHostnames.add(host);
    }
  }

  // 封鎖名單沿用 upstream 的比對方式：去掉單一前導 `www.` 後精確比對，
  // 確保 validator 拒絕的範圍恰好覆蓋 upstream 原本會放行的形式。
  const deniedHostnames = new Set<string>();
  for (const entry of deniedDomains) {
    const host = canonicalizeHostname(entry.trim().toLowerCase());
    if (host) deniedHostnames.add(host);
  }

  return function validateEmbedUrl(url: string): boolean | undefined {
    const hostname = parseHostname(url);
    if (!hostname) return undefined;

    if (deniedHostnames.has(hostname.replace(/^www\./, ""))) return false;

    if (exactHostnames.has(hostname)) return true;

    // 長度必須嚴格大於 suffix，確保 `.example.com` 不會命中 apex `example.com`。
    const matchesWildcard = wildcardSuffixes.some(
      (suffix) => hostname.length > suffix.length && hostname.endsWith(suffix),
    );

    return matchesWildcard ? true : undefined;
  };
}

// 無法解析（或沒有 host，例如 `mailto:`）的網址一律回傳 undefined。
// hostname 剝除 DNS 等價的單一尾點，與條目的 canonical 形式一致。
function parseHostname(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

// 把設定條目轉成 canonical hostname：交給 URL parser 做 IDNA/punycode
// 正規化並剝除尾點；空字串或無法解析時回傳 undefined（條目視為無效）。
//
// canonical 化之前先驗證條目只含 hostname——帶 path、port、userinfo、
// query、fragment 或空白的條目一律拒絕，否則 `*.com/evil` 這類手誤會被
// URL parser 靜默截成 `.com` suffix 而放行整個 TLD（fail-open）。
const NON_HOSTNAME_SYNTAX = /[/\\:@?#\s]/;

function canonicalizeHostname(value: string): string | undefined {
  const trimmed = value.replace(/\.$/, "");
  if (!trimmed || NON_HOSTNAME_SYNTAX.test(trimmed)) return undefined;
  try {
    const hostname = new URL(`https://${trimmed}/`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    return hostname || undefined;
  } catch {
    return undefined;
  }
}
