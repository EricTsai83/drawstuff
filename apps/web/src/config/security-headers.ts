// Security headers 與 CSP 的單一來源（threat model B6/T16；ADR-0004）。
// `next.config.ts` 的 `headers()` 在 build 時呼叫這裡，值凍結進部署——env 改變
// 即重新部署，與現行部署模型一致。政策由 `tests/security-headers.test.ts` 釘住。
//
// CSP 是 defense-in-depth，不是授權機制（CLAIM-CDB-3）：`connect-src` 收斂
// 「把 room key 送出去」的出口，但不阻止送往 allowlist 內的 origin，也不使
// E2EE 對抗能改動 bundle 的 operator 成立。

import { EMBED_FRAME_SRC_HOSTS } from "./embed-allowlist";

// Enforce（2026-08-28 起）：report-only 走查（docs/operations/web-security-headers.md
// 清單）已逐項完成、零預期外違規後切換。日後放寬或新增來源時，先改回 true 以
// report-only 重新走查，再切回 enforce。不接 report-uri/report-to——違規報告含
// URL，而 fragment 是金鑰載體，不為此新增外部出口。
export const CSP_REPORT_ONLY = false;

export interface SecurityHeadersInput {
  /** `next dev`；dev 放寬（HMR、unpkg react-grab）不得洩入 production。 */
  isDev: boolean;
  /** server-only `COLLAB_RELAY_URL`；取 origin 進 `connect-src`。 */
  collabRelayUrl: string | undefined;
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

function resolveRelayOrigin(input: SecurityHeadersInput): string | undefined {
  if (input.collabRelayUrl) {
    try {
      const url = new URL(input.collabRelayUrl);
      // URL parser 接受 `wss://*.example.com` 這類 hostname；CSP 只允許精確
      // 的 relay origin，scheme 也限定 WebSocket（與 env 文件一致），其餘
      // 一律視同設錯而 fail build。
      if (
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        !url.hostname.includes("*") &&
        url.origin !== "null"
      ) {
        return url.origin;
      }
    } catch {
      // 落到下方的缺失處理
    }
  }
  if (input.allowIncompleteEnv) return undefined;
  throw new Error(
    "CSP: COLLAB_RELAY_URL is missing, unparsable, non-WebSocket, or wildcarded; refusing to emit a connect-src without an exact relay origin.",
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
    // asset-store／published viewer／import 的 ciphertext fetch
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
    // P3.0：Excalidraw 字型由 /excalidraw-assets 自家 origin 提供，esm.sh
    // fallback 不得出現在任何 directive
    `font-src 'self'`,
    // Excalidraw subset worker 是 bundle 內的同源 module worker；blob: 供
    // report-only 走查確認後若無違規即可移除
    `worker-src 'self' blob:`,
    `connect-src ${connectSrc.join(" ")}`,
    // embed 決策的單一來源在 embed-allowlist.ts，與 validateEmbeddable 一致
    `frame-src ${EMBED_FRAME_SRC_HOSTS.join(" ")}`,
  ];

  return directives.join("; ");
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
