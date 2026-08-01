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

/**
 * 依補充名單建立 `validateEmbeddable` 用的驗證函式。
 *
 * 回傳值刻意只有 `true` 與 `undefined`：
 * - `true`：hostname 命中補充名單，直接放行。
 * - `undefined`：交還給 upstream，改用它內建的白名單判斷（YouTube 等維持原行為）。
 *
 * 永遠不回傳 `false`，避免這份補充名單反過來把 upstream 原本允許的網域擋掉。
 */
export function createEmbedUrlValidator(
  domains: readonly string[],
): (url: string) => true | undefined {
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

  return function validateEmbedUrl(url: string): true | undefined {
    const hostname = parseHostname(url);
    if (!hostname) return undefined;

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
