export const APP_ERROR = {
  SCENE_NOT_FOUND: "SCENE_NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  CREATE_FAILED: "CREATE_FAILED",
  SAVE_FAILED: "SAVE_FAILED",
} as const;
export type AppErrorCode = (typeof APP_ERROR)[keyof typeof APP_ERROR];

// Result helpers for non-throw control flow
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorCode; message?: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data } as const;
}

export function err(error: AppErrorCode, message?: string): Result<never> {
  return { ok: false, error, message } as const;
}

export function isOk<T>(r: Result<T>): r is { ok: true; data: T } {
  return r.ok === true;
}

export function isErr<T>(
  r: Result<T>,
): r is { ok: false; error: AppErrorCode; message?: string } {
  return r.ok === false;
}
