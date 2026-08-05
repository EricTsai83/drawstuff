/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.ts";

import type { NextConfig } from "next";

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
      { protocol: "https", hostname: "0tdnyn6tr7.ufs.sh", pathname: "/f/*" },
    ],
  },
};

export default config;
