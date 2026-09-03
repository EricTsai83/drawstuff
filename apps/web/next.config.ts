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
    ];
  },
};

export default config;
