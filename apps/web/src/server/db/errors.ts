/** Postgres SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver failures in `DrizzleQueryError` with the postgres-js
 * error as `cause`; accept either layer so callers need not know which one
 * surfaced.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if ("code" in current && current.code === UNIQUE_VIOLATION) return true;
  }
  return false;
}
