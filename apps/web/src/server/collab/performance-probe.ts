import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PERFORMANCE_PROBE_HEADER } from "@drawstuff/collaboration/performance";

const sign = (secret: string, value: string) =>
  createHmac("sha256", secret)
    .update(`collaboration-asset-performance-v1:${value}`)
    .digest();

export function issuePerformanceProbe(secret: string): string {
  if (secret.length < 32) throw new Error("performance-secret-unavailable");
  const value = `${Math.floor(Date.now() / 1000) + 60}.${randomUUID()}`;
  return `${value}.${sign(secret, value).toString("base64url")}`;
}

/** Browser cookies alone never enable private timing metadata. */
export function performanceProbeAuthorized(
  request: Request,
  secret: string | undefined,
): boolean {
  const header = request.headers.get(PERFORMANCE_PROBE_HEADER);
  if (!secret || secret.length < 32 || !header || header.length > 128)
    return false;
  const match = /^(\d{10})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return false;
  const now = Math.floor(Date.now() / 1000);
  const expires = Number(match[1]);
  if (expires <= now || expires > now + 60) return false;
  const received = Buffer.from(match[3]!, "base64url");
  const expected = sign(secret, `${match[1]}.${match[2]}`);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
