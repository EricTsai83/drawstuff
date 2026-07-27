import { env } from "@/env";

export function getBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  if (env.NEXT_PUBLIC_BASE_URL) return env.NEXT_PUBLIC_BASE_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
