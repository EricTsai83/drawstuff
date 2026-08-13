/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.ts";

import type { NextConfig } from "next";

// UploadThing 檔案網域為 <appId>.ufs.sh，appId 藏在 token（base64 JSON）裡。
// 從 env 導出 hostname，避免硬編特定 app id；解析失敗時退回萬用網域。
function getUploadThingHostname(): string {
  try {
    const token = process.env.UPLOADTHING_TOKEN;
    if (token) {
      const parsed: unknown = JSON.parse(
        Buffer.from(token, "base64").toString("utf8"),
      );
      const appId = (parsed as { appId?: unknown }).appId;
      if (typeof appId === "string" && appId.length > 0) {
        return `${appId}.ufs.sh`;
      }
    }
  } catch {
    // token 格式不符時走 fallback
  }
  return "*.ufs.sh";
}

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
        hostname: getUploadThingHostname(),
        pathname: "/f/*",
      },
    ],
  },
};

export default config;
