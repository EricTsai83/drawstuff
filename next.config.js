/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
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
