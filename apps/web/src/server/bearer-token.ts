import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of `Authorization: Bearer <secret>`.
 *
 * `!==` on the header would leak the secret one byte at a time through
 * response timing. An unset secret never matches (fail closed), and a length
 * mismatch is compared explicitly because `timingSafeEqual` throws on one —
 * the length itself is not secret.
 */
export function bearerTokenMatches(
  request: Request,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}
