// 刻意不 import `@/env`：這個 helper 進 client bundle，直接讀
// process.env.NEXT_PUBLIC_BASE_URL（build 時 inline），讓 `@/env` 未來可以加
// `server-only` guard。
export function getBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
