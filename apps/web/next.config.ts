/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.ts";

import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@drawstuff/whiteboard"],
  devIndicators: false,
  // T3 Code's collaborative preview reaches the local dev server through
  // 127.0.0.1. Next.js otherwise blocks its dev assets and HMR websocket.
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    resolveAlias: {
      "@/test-mode/whiteboard-test-harness":
        process.env.NEXT_PUBLIC_WHITEBOARD_TEST_MODE === "1"
          ? "./src/test-mode/whiteboard-test-harness.tsx"
          : "./src/test-mode/whiteboard-test-disabled.tsx",
    },
  },
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
