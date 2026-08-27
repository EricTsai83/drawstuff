import type { RoomRole } from "@drawstuff/collaboration/room-auth";
import type { RoomTokenFailureReason } from "@drawstuff/collaboration/room-token";

/**
 * Structured Workers Logs for the gateway and the room Object — the DO
 * counterpart of the relay's `src/logger.ts`, adapted to the platform: no
 * stdout sink or backpressure policy (workerd owns log delivery), no
 * process-level level threshold (Workers Logs filters at query time), and the
 * deployment version rides in every record so canary comparisons can group by
 * it (`wrangler.jsonc` `version_metadata` binding).
 *
 * The schema is closed on both layers, exactly like the relay's: a closed
 * event union, a closed typed field set with no `message`/`details`/`error`
 * escape hatch, and a runtime allowlist that drops (and counts) any field a
 * structurally-typed variable smuggles past the compiler. The classification
 * is threat model §5: verified `roomId`/`peerId` and bounded enums may be
 * logged; tokens, payload bytes, raw subjects and payload-derived error
 * detail may not. Error objects are therefore reduced to their constructor
 * name — a runtime-defined identifier, never content.
 */

type DoLogEvent =
  | "gateway.unhandled_failure"
  /** COLLAB_ALLOWED_ORIGINS failed to parse; socket upgrades answer 503. */
  | "gateway.config_invalid"
  | "gateway.secret_not_ready"
  | "gateway.room_fetch_failed"
  | "gateway.control_token_rejected"
  | "gateway.control_applied"
  | "gateway.control_dispatch_failed"
  /** The Object was addressed without a canonical RoomChannelKey name. */
  | "room.invalid_object_identity"
  /** A frame handler threw; that connection was closed, never the Object. */
  | "room.frame_dispatch_failed"
  | "room.socket_error"
  | "room.secret_not_ready"
  | "room.fanout_write_failed"
  | "room.session_joined"
  /** Every server-stated close, with its close-code verdict. */
  | "room.session_closed"
  /** The cron trigger fired but the drain secrets are missing. */
  | "cron.outbox_drain_not_configured"
  /** The outbox drain ping got no 2xx (or no response) from the web app. */
  | "cron.outbox_drain_failed";

type DoLogLevel = "info" | "warn" | "error";

type DoLogFields = {
  /** Opaque room id from the *verified* token or route; never pre-auth input. */
  roomId?: string;
  authGeneration?: number;
  /** Object-generated, opaque by construction. */
  peerId?: string;
  role?: RoomRole;
  closeCode?: number;
  /** Attachment state at close time; "unknown" for unreadable attachments. */
  socketState?: "pending" | "joined" | "unknown";
  /** Enumerated verification failure; carries no part of the token. */
  tokenFailure?: RoomTokenFailureReason;
  controlAction?: "end-room" | "revoke-member";
  closedSessions?: number;
  /** Joined members after the change the record describes. */
  members?: number;
  /** HTTP status of a failed server-to-server call (the drain ping). */
  status?: number;
  /** `Error` constructor name only — never `message`, which can embed input. */
  errorName?: string;
};

/**
 * Runtime half of the allowlist, `Record<keyof DoLogFields, true>` so the
 * compiler rejects drift in both directions (see the relay logger).
 */
const LOGGABLE_FIELDS: Record<keyof DoLogFields, true> = {
  roomId: true,
  authGeneration: true,
  peerId: true,
  role: true,
  closeCode: true,
  socketState: true,
  tokenFailure: true,
  controlAction: true,
  closedSessions: true,
  members: true,
  status: true,
  errorName: true,
};

/** The allowlist as names, for tests and the observability contract doc. */
export const DO_LOGGABLE_FIELD_NAMES: readonly string[] =
  Object.keys(LOGGABLE_FIELDS);

/** Fields every record carries ahead of the classified ones. */
export const DO_LOG_ENVELOPE_FIELDS: readonly string[] = [
  "event",
  "versionId",
  "versionTag",
];

export type DoLogger = {
  info(event: DoLogEvent, fields?: DoLogFields): void;
  warn(event: DoLogEvent, fields?: DoLogFields): void;
  error(event: DoLogEvent, fields?: DoLogFields): void;
};

/**
 * Built-in error kinds this logger can name. The classification is a *closed
 * enum owned here* — deliberately not read off the thrown value.
 *
 * Both `error.name` and `error.constructor` are writable: an SDK that stamped
 * a URL or a token fragment onto either would otherwise put that content
 * straight into a log line, and a `constructor` accessor could throw from
 * inside an exception handler. Matching against constructors this module
 * itself holds means the output is always one of these fixed strings, never
 * anything the thrown value carries.
 */
const ERROR_KINDS: readonly (readonly [ErrorConstructor, string])[] = [
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [EvalError, "EvalError"],
  [URIError, "URIError"],
];

/**
 * Reduces an unknown thrown value to a loggable, content-free identifier:
 * one of {@link ERROR_KINDS}, `"Error"` for any other error, or the `typeof`
 * for a non-error. Total by construction — a hostile getter or
 * `Symbol.hasInstance` cannot make it throw or return foreign content, which
 * matters because every caller is already inside an exception handler.
 */
export function errorNameOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error;
    for (const [kind, name] of ERROR_KINDS) {
      if (error instanceof kind) return name;
    }
    return "Error";
  } catch {
    return "unknown";
  }
}

type DoLogSink = (level: DoLogLevel, record: Record<string, unknown>) => void;

/** Default sink: one structured object per record, which Workers Logs
 *  captures as queryable fields rather than a flat string. */
const consoleSink: DoLogSink = (level, record) => {
  console[level](record);
};

export function createDoLogger(
  version?: { id: string; tag?: string },
  sink: DoLogSink = consoleSink,
): DoLogger {
  const emit = (
    level: DoLogLevel,
    event: DoLogEvent,
    fields: DoLogFields | undefined,
  ): void => {
    const record: Record<string, unknown> = { event };
    if (version?.id !== undefined) record.versionId = version.id;
    // The tag is empty on untagged deploys; an absent field reads better in
    // queries than an empty string.
    if (version?.tag !== undefined && version.tag !== "") {
      record.versionTag = version.tag;
    }
    let rejectedFields = 0;
    for (const [name, value] of Object.entries(fields ?? {})) {
      // TypeScript only rejects excess properties on literals, so the field
      // set is re-checked where the data classification actually applies. A
      // rejected field is a code defect; it is counted into the record itself
      // (this logger has no metrics endpoint to count it into).
      if (!Object.hasOwn(LOGGABLE_FIELDS, name)) {
        rejectedFields += 1;
        continue;
      }
      if (value !== undefined) record[name] = value;
    }
    if (rejectedFields > 0) record.rejectedFields = rejectedFields;
    sink(level, record);
  };

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
