/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.ts";

import type { NextConfig } from "next";

import {
  buildSecurityHeaders,
  deriveUploadThingAppId,
} from "./src/config/security-headers.ts";

// next/image 的 remote allowlist 沿用既有行為：token 缺失時退回萬用網域。
// CSP 的 connect-src 沒有這個 fallback——缺 token 直接 fail build
// （見 security-headers.ts 的 CLAIM-CDB-4 註解）。
const uploadThingAppId = deriveUploadThingAppId(process.env.UPLOADTHING_TOKEN);
const uploadThingImageHostname = uploadThingAppId
  ? `${uploadThingAppId}.ufs.sh`
  : "*.ufs.sh";

const config: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  transpilePackages: [
    "@drawstuff/collaboration",
    "@drawstuff/excalidraw-adapter",
  ],
  experimental: {
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/authInterrupts
    authInterrupts: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: uploadThingImageHostname,
        pathname: "/f/*",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({
          isDev: process.env.NODE_ENV === "development",
          collabGatewayUrl: process.env.COLLAB_CONTROL_URL,
          uploadThingToken: process.env.UPLOADTHING_TOKEN,
          allowIncompleteEnv: !!process.env.SKIP_ENV_VALIDATION,
        }),
      },
      {
        // Next 對 public/ 預設 max-age=0：回訪會對每個用到的字型子集檔各發
        // 一次 revalidate。內容雜湊檔名（Excalifont、Xiaolai、ComicShanns 的
        // 32 位 hex）可以永久快取；不符合此 pattern 的維持預設：未雜湊的
        // Virgil／Cascadia／Liberation，以及 Nunito、Lilita 的 Google Fonts
        // 衍生檔名（版本穩定但不是內容雜湊，不冒 immutable 的風險）。同目錄的
        // fonts.css 內容隨字型檔變動但檔名沒有雜湊，刻意不在此規則內，維持
        // 預設 max-age=0 + ETag。
        source:
          "/excalidraw-assets/fonts/:family/:file([A-Za-z]+-Regular-[0-9a-f]{32}\\.woff2)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default config;
