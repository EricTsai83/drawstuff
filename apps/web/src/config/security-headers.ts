// Security headers 與 CSP 的單一來源（threat model B6/T16；ADR-0004）。
// `next.config.ts` 的 `headers()` 在 build 時呼叫這裡，值凍結進部署——env 改變
// 即重新部署，與現行部署模型一致。政策由 `tests/security-headers.test.ts` 釘住。
//
// CSP 是 defense-in-depth，不是授權機制（CLAIM-CDB-3）：`connect-src` 收斂
// 「把 room key 送出去」的出口，但不阻止送往 allowlist 內的 origin，也不使
// E2EE 對抗能改動 bundle 的 operator 成立。

import { EMBED_FRAME_SRC_HOSTS } from "./embed-allowlist";

// 整站與公開頁共用 rollout 旗標。變更時依
// docs/operations/web-security-headers.md 的「Report-only → enforce 程序」走查。
// 不接違規報告端點的理由見 ADR-0004 CLAIM-CDB-1。
export const CSP_REPORT_ONLY = false;

/** `next.config.ts` `headers()` 的 `source`；必須排在整站規則之後才能覆蓋。 */
export const PUBLIC_VIEWER_ROUTE_SOURCE = "/p/:slug*";

export interface SecurityHeadersInput {
  /** `next dev`；dev 放寬（HMR、unpkg react-grab）不得洩入 production。 */
  isDev: boolean;
  /** server-only `COLLAB_CONTROL_URL`；導出 WebSocket origin 進 `connect-src`。 */
  collabGatewayUrl: string | undefined;
  /** UploadThing token（base64 JSON）；導出 `<appId>.ufs.sh`。 */
  uploadThingToken: string | undefined;
  /**
   * `SKIP_ENV_VALIDATION` build（CI）。此時缺失的 env 來源直接省略，
   * 永不退回萬用網域（CLAIM-CDB-4）；非 skip build 缺 env 則 fail build。
   */
  allowIncompleteEnv: boolean;
}

// UploadThing 檔案網域為 <appId>.ufs.sh，appId 藏在 token（base64 JSON）裡。
// 從 env 導出，避免硬編特定 app id；解析失敗回傳 undefined，由呼叫端決定
// fail build（CSP）或退回既有 image 萬用網域（next/image remotePatterns）。
//
// appId 會被插進 CSP directive，必須是單一 DNS-safe label：`*`、空白或
// 分隔符等值一律視同 token 不可用，寧可 fail build 也不讓 `https://*.ufs.sh`
// 或壞掉的 directive 靜默出現（CLAIM-CDB-4）。
const DNS_SAFE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function deriveUploadThingAppId(
  token: string | undefined,
): string | undefined {
  if (!token) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, "base64").toString("utf8"),
    );
    const appId = (parsed as { appId?: unknown }).appId;
    if (typeof appId === "string" && DNS_SAFE_LABEL.test(appId)) return appId;
  } catch {
    // token 格式不符：視同缺失
  }
  return undefined;
}

/**
 * Durable Object gateway 的 WebSocket origin：同一個 Worker 同時服務 control
 * endpoint 與 room socket，所以由 `COLLAB_CONTROL_URL` 的 http(s) origin 換成
 * ws(s)。與 `server/collab/relay-routing.ts` 用同一條規則。
 */
function deriveGatewaySocketOrigin(gatewayUrl: string): string | undefined {
  try {
    const url = new URL(gatewayUrl);
    // URL parser 接受 `https://*.example.com` 這類 hostname；CSP 只允許精確
    // 的 gateway origin，scheme 也限定 http(s)，其餘一律視同設錯。
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.hostname.includes("*") &&
      url.origin !== "null"
    ) {
      return url.origin.replace(/^http/, "ws");
    }
  } catch {
    // 落到呼叫端的缺失處理
  }
  return undefined;
}

function resolveRelayOrigin(input: SecurityHeadersInput): string | undefined {
  const origin = input.collabGatewayUrl
    ? deriveGatewaySocketOrigin(input.collabGatewayUrl)
    : undefined;
  if (origin) return origin;
  if (input.allowIncompleteEnv) return undefined;
  throw new Error(
    "CSP: COLLAB_CONTROL_URL is missing, unparsable, non-HTTP, or wildcarded; refusing to emit a connect-src without an exact gateway origin.",
  );
}

function resolveUfsHost(input: SecurityHeadersInput): string | undefined {
  const appId = deriveUploadThingAppId(input.uploadThingToken);
  if (appId) return `https://${appId}.ufs.sh`;
  if (input.allowIncompleteEnv) return undefined;
  // CLAIM-CDB-4：這裡絕不退回 `*.ufs.sh`。
  throw new Error(
    "CSP: UPLOADTHING_TOKEN is missing or unparsable; refusing to emit a wildcard *.ufs.sh connect-src.",
  );
}

export function buildContentSecurityPolicy(
  input: SecurityHeadersInput,
): string {
  const relayOrigin = resolveRelayOrigin(input);
  const ufsHost = resolveUfsHost(input);

  const connectSrc = [
    // tRPC（httpBatchStreamLink）、Server Actions、/api/uploadthing presign
    "'self'",
    // Durable Object gateway WebSocket（B1）
    ...(relayOrigin ? [relayOrigin] : []),
    // browser 直傳 ingest region 子網域（uploadthing 7.7.4 upload-builder）；
    // api.uploadthing.com 是 server-side presign 端點，browser 不連，不列入。
    "https://*.ingest.uploadthing.com",
    // asset-store／import 的 ciphertext，以及 published viewer 的成品 SVG
    ...(ufsHost ? [ufsHost] : []),
    // 官方 library 安裝（packages/excalidraw-adapter fetchOfficialExcalidrawLibrary）
    "https://libraries.excalidraw.com",
    // Turbopack HMR websocket 與 dev 工具
    ...(input.isDev ? ["ws://127.0.0.1:*", "ws://localhost:*"] : []),
  ];

  const scriptSrc = [
    "'self'",
    // 靜態 CSP（無 per-request nonce middleware）下無法 hash App Router 逐
    // request 串流的 inline flight script，NextSSRPlugin 與 next-themes 也
    // 各注入一段無 nonce inline script；因此保留 'unsafe-inline'，本 CSP 的
    // 核心控制是 connect-src 出口收斂，不是 inline script 防護（ADR-0004）。
    "'unsafe-inline'",
    // 工作區匯出 SVG／PNG 的 harfbuzz 字型 subset 需要 wasm 編譯，不需 JS eval。
    // 被擋時上游會退回 esm.sh 字型；公開 viewer 不載入引擎，另用收緊政策。
    "'wasm-unsafe-eval'",
    // dev-only：Turbopack eval sourcemap 與 unpkg 載入的 react-grab
    ...(input.isDev ? ["'unsafe-eval'", "unpkg.com"] : []),
  ];

  const directives = [
    `default-src 'self'`,
    `base-uri 'none'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    // React style attribute 與 next/font/Excalidraw 注入的 style 元素
    `style-src 'self' 'unsafe-inline'`,
    // blob:/data:：canvas 匯出與解密後的 asset object URL；lh3：better-auth
    // Google profile 頭像走原生 <img>，不經 next/image
    `img-src 'self' blob: data: https://lh3.googleusercontent.com`,
    // /excalidraw-assets/ 自託管字型：編輯器用 FontFace API，公開頁用 fonts.css。
    // 成品不內嵌字型，不開放 data: 或 esm.sh fallback。
    `font-src 'self'`,
    // 保留給同源 Excalidraw subset worker；現有 Turbopack 走查發現 worker URL
    // 解析成 file:///ROOT/... 後啟動失敗，上游改走主執行緒。未使用 blob:。
    `worker-src 'self'`,
    `connect-src ${connectSrc.join(" ")}`,
    // embed 決策的單一來源在 embed-allowlist.ts，與 validateEmbeddable 一致
    `frame-src ${EMBED_FRAME_SRC_HOSTS.join(" ")}`,
  ];

  return directives.join("; ");
}

/**
 * 公開 viewer 只需 app chunks、同源字型與成品 SVG；政策必須是整站的子集。
 * 成品先經 sanitizer 再掛入 DOM，CSP 是額外防線。Inline script 供 framework
 * 使用，inline style 供 React 與 SVG 文字使用。理由見 docs/architecture/web-csp-design.md。
 */
export function buildPublicViewerContentSecurityPolicy(
  input: SecurityHeadersInput,
): string {
  const ufsHost = resolveUfsHost(input);

  const connectSrc = [
    // 同源資源請求；頁面資料由 server 查詢。離開公開頁須整頁導覽以替換 CSP。
    "'self'",
    // 成品 SVG（淺／深各一份）
    ...(ufsHost ? [ufsHost] : []),
    ...(input.isDev ? ["ws://127.0.0.1:*", "ws://localhost:*"] : []),
  ];

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    // 沒有 'wasm-unsafe-eval'：這條路由不載入引擎，wasm 編譯沒有使用者。
    ...(input.isDev ? ["'unsafe-eval'", "unpkg.com"] : []),
  ];

  return [
    `default-src 'self'`,
    `base-uri 'none'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    // 成品把場景圖片以 data URL 內嵌；沒有 canvas 匯出（blob:）也沒有 Google 頭像
    `img-src 'self' data:`,
    // /excalidraw-assets/fonts.css 與同源 woff2
    `font-src 'self'`,
    `worker-src 'none'`,
    `connect-src ${connectSrc.join(" ")}`,
    // 公開頁不渲染 embed；成品的 sanitizer 也已移除 iframe
    `frame-src 'none'`,
  ].join("; ");
}

/**
 * 公開頁只覆蓋 CSP，其餘 headers 沿用整站；規則須排在整站之後。
 * 共用 rollout 旗標，公開頁驗證見 docs/operations/web-security-headers.md 第 11 項。
 */
export function buildPublicViewerSecurityHeaders(
  input: SecurityHeadersInput,
): { key: string; value: string }[] {
  return [
    {
      key: CSP_REPORT_ONLY
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
      value: buildPublicViewerContentSecurityPolicy(input),
    },
  ];
}

export function buildSecurityHeaders(
  input: SecurityHeadersInput,
): { key: string; value: string }[] {
  return [
    {
      key: CSP_REPORT_ONLY
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
      value: buildContentSecurityPolicy(input),
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // room key 在 fragment，不隨 Referer 送出；仍取最嚴格值縮小 URL 洩漏面
    { key: "Referrer-Policy", value: "no-referrer" },
    // 與 frame-ancestors 'none' 並存，涵蓋不支援 CSP 的舊代理/瀏覽器
    { key: "X-Frame-Options", value: "DENY" },
  ];
}
