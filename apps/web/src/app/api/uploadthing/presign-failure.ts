import { TRPCError } from "@trpc/server";
import { AdapterError } from "@/server/collab/authority-storage";
import { recordOpsSignal } from "@/server/ops/settings";

/** Where the collaboration asset presign middleware was when it threw. */
export type PresignFailureStage = "session" | "quota" | "authority";

/**
 * Error kinds this module can name — a closed list owned here, never read off
 * the thrown value, whose `name` and `constructor` are both writable.
 */
const ERROR_KINDS: readonly (readonly [
  abstract new (...args: never[]) => Error,
  string,
])[] = [
  [TRPCError, "TRPCError"],
  [AdapterError, "AdapterError"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
];

/**
 * Codes that may be logged, per error kind. `code` is writable like `name`,
 * so it is matched against these sets rather than passed through; the
 * `Record` types make the compiler flag a code added to either union.
 */
const TRPC_CODES: Record<TRPCError["code"], true> = {
  PARSE_ERROR: true,
  BAD_REQUEST: true,
  INTERNAL_SERVER_ERROR: true,
  NOT_IMPLEMENTED: true,
  BAD_GATEWAY: true,
  SERVICE_UNAVAILABLE: true,
  GATEWAY_TIMEOUT: true,
  UNAUTHORIZED: true,
  PAYMENT_REQUIRED: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  METHOD_NOT_SUPPORTED: true,
  TIMEOUT: true,
  CONFLICT: true,
  PRECONDITION_FAILED: true,
  PAYLOAD_TOO_LARGE: true,
  UNSUPPORTED_MEDIA_TYPE: true,
  UNPROCESSABLE_CONTENT: true,
  PRECONDITION_REQUIRED: true,
  TOO_MANY_REQUESTS: true,
  CLIENT_CLOSED_REQUEST: true,
};
const ADAPTER_CODES: Record<AdapterError["code"], true> = {
  "operation-mismatch": true,
  "invalid-body": true,
  "body-too-large": true,
  "fence-mismatch": true,
  "not-found": true,
  capacity: true,
  "initialization-incomplete": true,
};

function knownCode(error: Error): string | undefined {
  const [codes, code]: [Record<string, true>, unknown] =
    error instanceof TRPCError
      ? [TRPC_CODES, error.code]
      : error instanceof AdapterError
        ? [ADAPTER_CODES, error.code]
        : [{}, undefined];
  return typeof code === "string" && Object.hasOwn(codes, code)
    ? code
    : undefined;
}

function classify(error: unknown): { errorName: string; code?: string } {
  try {
    if (!(error instanceof Error)) return { errorName: typeof error };
    for (const [kind, errorName] of ERROR_KINDS) {
      if (!(error instanceof kind)) continue;
      const code = knownCode(error);
      return code === undefined ? { errorName } : { errorName, code };
    }
    return { errorName: "Error" };
  } catch {
    return { errorName: "unknown" };
  }
}

/**
 * UploadThing answers every middleware throw with a bare 500 and logs nothing
 * an operator can use, so a failed presign was indistinguishable from any
 * other 500. One closed-schema line per failure — stage, constructor name and
 * the app's own error code, never the message (threat model §5) — plus a
 * throttled Neon counter, since Hobby runtime logs expire quickly.
 */
export function reportPresignFailure(
  stage: PresignFailureStage,
  error: unknown,
): void {
  console.warn(
    JSON.stringify({
      event: "collab.asset_presign.failed",
      stage,
      ...classify(error),
    }),
  );
  void recordOpsSignal(`asset-presign.failed:${stage}`).catch(() => undefined);
}
