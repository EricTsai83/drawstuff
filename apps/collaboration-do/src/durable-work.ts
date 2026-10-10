import {
  AUTHORITY_LIMITS,
  durableJobSchema,
  type DurableJob,
} from "@drawstuff/collaboration/authority";

import { createDoLogger } from "./logger.ts";

/**
 * How long one job may keep failing (or answering "not yet") before it is
 * abandoned. Without a bound, a job the web adapter refuses forever would wake
 * its Object by alarm once a minute indefinitely. Every job's local effect is
 * already committed when it is queued; abandoning only stops the remote side
 * from catching up, which the logged event makes visible.
 */
const WORK_ABANDON_MS = 24 * 60 * 60_000;

type WorkRow = {
  id: string;
  body: string;
  security: number;
  attempts: number;
  next_at: number;
  version: number;
  first_at: number;
};

/** Shared local transaction/alarm pattern for Room and Lifecycle. No external I/O inside commit. */
export class DurableWork {
  constructor(
    private readonly storage: DurableObjectStorage,
    /**
     * Opts this queue into abandonment after `WORK_ABANDON_MS`, settling the
     * local records an abandoned job would otherwise leave pending forever.
     * Without it jobs retry indefinitely: Lifecycle retirement must finish
     * deleting an account's data rather than give up.
     */
    private readonly onAbandon?: (job: DurableJob) => void,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS authority_work (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, security INTEGER NOT NULL CHECK(security IN (0,1)),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), next_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0), last_failure TEXT CHECK(last_failure IN ('delivery-failed')),
      first_at INTEGER
    ); CREATE INDEX IF NOT EXISTS authority_work_due ON authority_work(security DESC,next_at,id);
    CREATE TABLE IF NOT EXISTS authority_results (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL, terminal_at INTEGER
    );`);
    // Lifecycle Objects predate `first_at`; their queued jobs start the clock now.
    if (
      !storage.sql
        .exec<{ name: string }>("PRAGMA table_info(authority_work)")
        .toArray()
        .some((column) => column.name === "first_at")
    )
      storage.sql.exec(
        "ALTER TABLE authority_work ADD COLUMN first_at INTEGER",
      );
    storage.sql.exec(
      "UPDATE authority_work SET first_at=? WHERE first_at IS NULL",
      Date.now(),
    );
  }

  /** Jobs still queued, of any kind. */
  pending(): number {
    return this.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM authority_work")
      .one().count;
  }

  async commit<T>(
    change: () => T,
    extraDeadline?: number | (() => number | undefined),
  ): Promise<T> {
    return this.storage.transaction(async () => {
      const result = change();
      await this.schedule(
        typeof extraDeadline === "function" ? extraDeadline() : extraDeadline,
      );
      return result;
    });
  }

  enqueue(
    id: string,
    job: DurableJob,
    security: boolean,
    version = 1,
    now = Date.now(),
  ): boolean {
    const body = JSON.stringify(durableJobSchema.parse(job));
    if (new TextEncoder().encode(body).byteLength > AUTHORITY_LIMITS.jobBytes)
      throw new Error("job-too-large");
    const existing = this.storage.sql
      .exec<WorkRow>("SELECT * FROM authority_work WHERE id=?", id)
      .toArray()[0];
    if (existing) {
      if (version < existing.version) return true;
      if (version === existing.version) {
        if (existing.body !== body) throw new Error("job-mismatch");
        return true;
      }
      // Only monotonic projections and fences may merge; content/cleanup identities never disappear.
      if (
        job.kind !== "projection" &&
        job.kind !== "invite-projection" &&
        job.kind !== "fence"
      )
        throw new Error("job-mismatch");
      this.storage.sql.exec(
        // `first_at` stays: a job that keeps being superseded during an outage
        // is still the same undelivered work and must still be abandoned.
        "UPDATE authority_work SET body=?,version=?,next_at=min(next_at,?),attempts=0,last_failure=NULL WHERE id=?",
        body,
        version,
        now,
        id,
      );
      return true;
    }
    const count = this.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM authority_work WHERE security=? AND id NOT IN ('emergency-fence','emergency-cleanup')",
        Number(security),
      )
      .one().count;
    if (
      count >=
      (security ? AUTHORITY_LIMITS.securityJobs : AUTHORITY_LIMITS.normalJobs)
    )
      return false;
    this.storage.sql.exec(
      "INSERT INTO authority_work(id,body,security,next_at,version,first_at) VALUES (?,?,?,?,?,?)",
      id,
      body,
      Number(security),
      now,
      version,
      now,
    );
    return true;
  }

  /** One fixed room-wide fence survives exhausted reserve capacity. Caller durably denies the whole room. */
  emergencyFence(job: Extract<DurableJob, { kind: "fence" }>): void {
    this.storage.sql.exec(
      `INSERT INTO authority_work(id,body,security,next_at,version,first_at) VALUES ('emergency-fence',?,1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body,version=excluded.version,next_at=min(next_at,excluded.next_at)
      WHERE excluded.version>version`,
      JSON.stringify(job),
      Date.now(),
      job.authorityEpoch,
      Date.now(),
    );
  }

  emergencyCleanup(job: Extract<DurableJob, { kind: "cleanup" }>): void {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO authority_work(id,body,security,next_at,version,first_at) VALUES ('emergency-cleanup',?,1,?,1,?)",
      JSON.stringify(durableJobSchema.parse(job)),
      Date.now(),
      Date.now(),
    );
  }

  replay<T>(id: string, request: string): T | undefined {
    const row = this.storage.sql
      .exec<{ request: string; result: string }>(
        "SELECT request,result FROM authority_results WHERE id=?",
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    if (request !== row.request) throw new Error("operation-mismatch");
    return JSON.parse(row.result) as T;
  }

  query<T>(id: string): T | undefined {
    const row = this.storage.sql
      .exec<{ result: string }>(
        "SELECT result FROM authority_results WHERE id=?",
        id,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.result) as T) : undefined;
  }

  result(
    id: string,
    request: string,
    result: unknown,
    terminal: boolean,
  ): void {
    const existing = this.storage.sql
      .exec<{ request: string }>(
        "SELECT request FROM authority_results WHERE id=?",
        id,
      )
      .toArray()[0];
    if (existing && existing.request !== request)
      throw new Error("operation-mismatch");
    if (
      !existing &&
      this.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM authority_results",
        )
        .one().count >= AUTHORITY_LIMITS.managementResults
    )
      throw new Error("capacity");
    this.storage.sql.exec(
      `INSERT INTO authority_results(id,request,result,terminal_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET result=excluded.result,terminal_at=coalesce(terminal_at,excluded.terminal_at)`,
      id,
      request,
      JSON.stringify(result),
      terminal ? Date.now() : null,
    );
  }

  prune(now = Date.now()): void {
    this.storage.sql.exec(
      "DELETE FROM authority_results WHERE terminal_at IS NOT NULL AND terminal_at<=?",
      now - AUTHORITY_LIMITS.resultRetentionMs,
    );
  }

  due(now = Date.now()): WorkRow[] {
    return this.storage.sql
      .exec<WorkRow>(
        "SELECT * FROM authority_work WHERE next_at<=? ORDER BY security DESC,next_at,id LIMIT ?",
        now,
        AUTHORITY_LIMITS.alarmBatch,
      )
      .toArray();
  }

  done(id: string, version: number): void {
    // An older response must not acknowledge a newer coalesced job.
    this.storage.sql.exec(
      "DELETE FROM authority_work WHERE id=? AND version=?",
      id,
      version,
    );
  }

  async drain(
    deliver: (
      job: DurableJob,
      timeoutMs: number,
      signal: AbortSignal,
    ) => Promise<boolean | void>,
    extraDeadline?: number | (() => number | undefined),
  ): Promise<void> {
    const started = Date.now();
    for (const row of this.due(started)) {
      if (this.onAbandon && started - row.first_at >= WORK_ABANDON_MS) {
        const job = durableJobSchema.parse(JSON.parse(row.body) as unknown);
        createDoLogger().error("authority.work_abandoned", {
          jobKind: job.kind,
        });
        await this.commit(() => {
          this.onAbandon?.(job);
          this.done(row.id, row.version);
        }, extraDeadline);
        continue;
      }
      const remaining = AUTHORITY_LIMITS.alarmBudgetMs - (Date.now() - started);
      if (remaining <= 0) break;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("delivery-timeout"));
          }, remaining);
        });
        const completed = await Promise.race([
          deliver(
            durableJobSchema.parse(JSON.parse(row.body) as unknown),
            remaining,
            controller.signal,
          ),
          timeout,
        ]);
        await this.commit(() => {
          if (completed !== false) this.done(row.id, row.version);
          else
            this.storage.sql.exec(
              "UPDATE authority_work SET attempts=0,next_at=?,last_failure=NULL WHERE id=? AND version=?",
              Date.now() + 1_000,
              row.id,
              row.version,
            );
        }, extraDeadline);
      } catch {
        await this.commit(() => {
          this.storage.sql.exec(
            "UPDATE authority_work SET attempts=attempts+1,next_at=?,last_failure='delivery-failed' WHERE id=? AND version=?",
            Date.now() +
              Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6)),
            row.id,
            row.version,
          );
        }, extraDeadline);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    await this.commit(() => this.prune(), extraDeadline);
  }

  nextDeadline(): number | undefined {
    return (
      this.storage.sql
        .exec<{ at: number | null }>(
          `SELECT min(at) AS at FROM (
      SELECT min(next_at) AS at FROM authority_work UNION ALL
      SELECT min(terminal_at)+? AS at FROM authority_results WHERE terminal_at IS NOT NULL
    )`,
          AUTHORITY_LIMITS.resultRetentionMs,
        )
        .one().at ?? undefined
    );
  }

  async schedule(extraDeadline?: number): Promise<void> {
    const deadline = this.nextDeadline();
    const next = Math.min(deadline ?? Infinity, extraDeadline ?? Infinity);
    if (Number.isFinite(next))
      await this.storage.setAlarm(Math.max(Date.now() + 1_000, next));
    else await this.storage.deleteAlarm();
  }
}
