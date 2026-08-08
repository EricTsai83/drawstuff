import { createHmac, randomBytes } from "node:crypto";

import type { MessageChannel } from "@drawstuff/collaboration/protocol";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";
import type { RoomTokenFailureReason } from "@drawstuff/collaboration/room-token";

import type { RelayCloseReason, RelayControlOutcome } from "./metrics.ts";

/**
 * Structured relay logs, one JSON object per line.
 *
 * This module is the relay's only output sink. Everything else in `src/` is
 * forbidden from writing to stdout or stderr — asserted by
 * `tests/package-contract.test.ts` — so there is exactly one place where a log
 * line can be produced and exactly one place to audit against the data
 * classification in `docs/architecture/collaboration-threat-model.md` §5.
 *
 * The classification is enforced twice, because one layer is not enough.
 * {@link RelayLogFields} is a *closed* set of typed fields with no `message`,
 * `details` or `error` escape hatch, so adding a field is an edit to this file
 * where the classification is documented. But TypeScript only rejects excess
 * properties on object *literals*: a variable of type `{ roomId, token }` is
 * assignable to `RelayLogFields`, and a structural type cannot stop it. So the
 * sink also filters every record against {@link LOGGABLE_FIELDS} at runtime and
 * counts what it rejected — a rejected field is a bug, and a silent drop would
 * hide it.
 */

/**
 * Every log event the relay can emit. A closed set, like the fields: the log
 * schema is declared here rather than accumulated from call sites. Not exported —
 * callers reach it through {@link RelayLogger}'s signatures, so there is one place
 * that decides what events exist.
 */
type RelayLogEvent =
  | "relay.starting"
  | "relay.startup_failed"
  | "relay.listening"
  | "relay.endpoint"
  /** The single-instance deployment declaration and its effective limits. */
  | "relay.single_instance"
  | "relay.draining"
  /** The drain window ended; carries what it closed and what it had to force. */
  | "relay.drained"
  /** RSS crossed the SLO §4.1 restart threshold; a drain-then-exit follows. */
  | "relay.memory_limit_exceeded"
  | "relay.stopped"
  | "relay.connection_rejected"
  | "relay.join"
  | "relay.join_refused"
  | "relay.connection_closed"
  | "relay.frame"
  | "relay.control";

export type RelayLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<RelayLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * The complete set of loggable fields.
 *
 * Allowed by threat model §5 and present here: opaque ids (`roomId`,
 * `authGeneration`, `peerId`), byte and frame counts, channel names,
 * close codes and disconnect reasons, latency and occupancy numbers.
 *
 * Forbidden by §5 and structurally absent: message content, ciphertext or any
 * base64 fragment, room keys, derived keys, tokens or token fragments, and
 * presence data — including `username`, which is user data the relay cannot read
 * anyway because presence payloads are sealed.
 *
 * `subject` is the one field that needs a decision rather than a rule. §6 left it
 * open; the observability contract permits only a pseudonym — see
 * {@link RelayLoggerOptions.subjectSalt}.
 */
type RelayLogFields = {
  roomId?: string;
  /** Authorization generation from the verified token, not the fanout epoch. */
  authGeneration?: number;
  /** Relay-generated, so it is opaque by construction. */
  peerId?: string;
  role?: RoomRole;
  /** Pseudonym of the token `sub`, never the raw id. */
  subject?: string;
  channel?: MessageChannel;
  byteLength?: number;
  closeCode?: number;
  closeReason?: RelayCloseReason;
  /** Enumerated verification failure; carries no part of the token. */
  tokenFailure?: RoomTokenFailureReason;
  /** Why a join was refused after its token verified. */
  joinRefusal?:
    | "membership-revoked"
    | "room-expired"
    | "room-at-capacity"
    | "relay-rooms-at-capacity"
    | "join-rate-limited"
    | "already-joined";
  sessionDurationMs?: number;
  connections?: number;
  rooms?: number;
  sessions?: number;
  members?: number;
  limit?: number;
  /** Drained sockets the drain deadline had to terminate. */
  forcedTerminations?: number;
  /** Elapsed time of the operation the record describes. */
  durationMs?: number;
  /** Process resident set size, for the max-memory watchdog's record. */
  rssBytes?: number;
  /** SLO §4.1 max-memory restart threshold in effect. */
  maxRssBytes?: number;
  /** Deployment envelope: the number of relay instances, which is always 1. */
  instances?: number;
  /** Effective capacity limits, for the startup declaration. */
  maxConnections?: number;
  maxRooms?: number;
  maxConnectionsPerRoom?: number;
  drainTimeoutMs?: number;
  controlAction?: "end-room" | "revoke-member";
  controlOutcome?: RelayControlOutcome;
  closedSessions?: number;
  /** Bind address of this process; not user data. */
  host?: string;
  port?: number;
  url?: string;
  path?: string;
  /** Name of an environment variable, for startup and configuration records. */
  configKey?: string;
};

/**
 * Runtime half of the allowlist.
 *
 * Typed as `Record<keyof RelayLogFields, true>` on purpose: that makes the
 * compiler reject both directions of drift — a field added to
 * {@link RelayLogFields} without a matching entry here, and an entry here that
 * is not a real field. So the runtime filter and the type can never disagree,
 * and there is still exactly one place that decides what a log line may carry.
 */
const LOGGABLE_FIELDS: Record<keyof RelayLogFields, true> = {
  roomId: true,
  authGeneration: true,
  peerId: true,
  role: true,
  subject: true,
  channel: true,
  byteLength: true,
  closeCode: true,
  closeReason: true,
  tokenFailure: true,
  joinRefusal: true,
  sessionDurationMs: true,
  connections: true,
  rooms: true,
  sessions: true,
  members: true,
  limit: true,
  forcedTerminations: true,
  durationMs: true,
  rssBytes: true,
  maxRssBytes: true,
  instances: true,
  maxConnections: true,
  maxRooms: true,
  maxConnectionsPerRoom: true,
  drainTimeoutMs: true,
  controlAction: true,
  controlOutcome: true,
  closedSessions: true,
  host: true,
  port: true,
  url: true,
  path: true,
  configKey: true,
};

/** The allowlist as names, for tests and for documenting the log schema. */
export const LOGGABLE_FIELD_NAMES: readonly string[] =
  Object.keys(LOGGABLE_FIELDS);

/** Fields every record carries, ahead of the classified ones. */
export const LOG_RECORD_ENVELOPE_FIELDS: readonly string[] = [
  "ts",
  "level",
  "event",
];

export type RelayLogger = {
  info(event: RelayLogEvent, fields?: RelayLogFields): void;
  warn(event: RelayLogEvent, fields?: RelayLogFields): void;
  error(event: RelayLogEvent, fields?: RelayLogFields): void;
  /**
   * A per-frame record. Off unless explicitly enabled: one line per routed frame
   * is a per-message log of a system whose whole point is that it keeps no
   * per-message record, and at the approved frame rates it is also the largest
   * write in the process. Enable it to debug a specific incident, not in steady
   * state.
   */
  frame(fields: RelayLogFields): void;
  /** True when {@link RelayLogger.frame} will actually write. */
  readonly logsFrames: boolean;
  /**
   * Pseudonymizes a value that must be correlatable but not recorded: the
   * token `sub`.
   */
  pseudonym(value: string): string;
  /** Records the sink refused because its stream was backed up. */
  droppedRecords(): number;
  /** Fields the runtime allowlist rejected; non-zero means a code defect. */
  rejectedFields(): number;
};

/**
 * Line sink. Returns false when the line was *not* accepted, which is how the
 * logger learns to count a drop rather than assume every record was written.
 */
type RelayLogSink = (line: string) => boolean;

/**
 * Default sink: stdout, with a bounded backpressure policy.
 *
 * `process.stdout.write` returns false once the OS buffer is full, and from then
 * on Node queues every further write **in memory, without bound**. In production
 * stdout is a pipe to a log collector, and a stalled collector is exactly the
 * case where the relay is also producing the most records — a bad-token
 * connection flood logs one refusal per attempt without passing the join-rate
 * budget, which is charged only after verification. Ignoring the return value
 * therefore turns the logger into the unbounded queue repo rule 5 forbids.
 *
 * So the queue is capped at the one line that discovered the backpressure:
 * everything after it is dropped until `drain`, and the drops are counted so the
 * gap is visible rather than silent.
 */
function createStdoutLogSink(): RelayLogSink {
  let backedUp = false;
  return (line) => {
    if (backedUp) return false;
    if (!process.stdout.write(line)) {
      backedUp = true;
      process.stdout.once("drain", () => {
        backedUp = false;
      });
    }
    return true;
  };
}

/** Hex characters of a pseudonym; 48 bits. */
const PSEUDONYM_LENGTH = 12;

export type RelayLoggerOptions = {
  level?: RelayLogLevel;
  logFrames?: boolean;
  /**
   * HMAC key for pseudonyms. Defaults to fresh random bytes per
   * process, which is the deliberate choice: threat model §5 forbids recording a
   * raw `sub`, and a per-process key additionally means the pseudonym cannot be
   * correlated across restarts or dictionary-attacked back to a user id. The cost
   * is that a subject's pseudonym changes when the relay restarts, which is
   * acceptable because what these logs are for — "which subject is churning
   * connections right now" — is a question about one process's lifetime. A stable
   * cross-restart pseudonym would be a separate, approved decision.
   */
  subjectSalt?: Buffer;
  /**
   * Line sink; defaults to {@link createStdoutLogSink}. Tests inject a collector.
   * Returning false means the line was dropped.
   */
  write?: RelayLogSink;
  /** Timestamp source; defaults to the wall clock. */
  now?: () => Date;
};

export function createRelayLogger(
  options: RelayLoggerOptions = {},
): RelayLogger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const logFrames = options.logFrames ?? false;
  const salt = options.subjectSalt ?? randomBytes(32);
  const write = options.write ?? createStdoutLogSink();
  const now = options.now ?? ((): Date => new Date());
  let droppedRecords = 0;
  let rejectedFields = 0;

  const writeRecord = (
    level: RelayLogLevel,
    event: RelayLogEvent,
    fields: RelayLogFields | undefined,
  ): void => {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      event,
    };
    for (const [name, value] of Object.entries(fields ?? {})) {
      // The runtime half of the allowlist. A caller can pass a *variable* that
      // structurally satisfies `RelayLogFields` while carrying extra properties —
      // TypeScript only rejects excess properties on literals — so the field set
      // is re-checked here, where the data classification actually applies.
      if (!Object.hasOwn(LOGGABLE_FIELDS, name)) {
        rejectedFields += 1;
        continue;
      }
      // Undefined fields are omitted rather than serialized as null: an absent
      // field and a null one would otherwise read as the same thing.
      if (value !== undefined) record[name] = value;
    }
    if (!write(`${JSON.stringify(record)}\n`)) droppedRecords += 1;
  };

  const emit = (
    level: RelayLogLevel,
    event: RelayLogEvent,
    fields: RelayLogFields | undefined,
  ): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    writeRecord(level, event, fields);
  };

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    frame(fields) {
      // `logFrames` is this record's own switch, so it does not also have to
      // clear the level threshold: enabling frame logging without also lowering
      // the level would otherwise silently produce nothing.
      if (!logFrames) return;
      writeRecord("debug", "relay.frame", fields);
    },
    logsFrames: logFrames,
    pseudonym: (value) =>
      createHmac("sha256", salt)
        .update(value)
        .digest("hex")
        .slice(0, PSEUDONYM_LENGTH),
    droppedRecords: () => droppedRecords,
    rejectedFields: () => rejectedFields,
  };
}
