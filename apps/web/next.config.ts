/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.ts";

import type { NextConfig } from "next";

const config: NextConfig = {
  env: {
    // Plan 11 collab POC flag（Plan 12 移除）：預設 "" 讓 key 一定存在，
    // 值才會在 build time inline，關閉時整個 POC branch 連同 dynamic chunk
    // 會被 dead-code elimination 移除。
    NEXT_PUBLIC_COLLAB_POC: process.env.NEXT_PUBLIC_COLLAB_POC ?? "",
  },
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  transpilePackages: ["@drawstuff/collaboration", "@drawstuff/excalidraw-adapter"],
  experimental: {
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/authInterrupts
    authInterrupts: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "0tdnyn6tr7.ufs.sh", pathname: "/f/*" },
    ],
  },
};

export default config;
