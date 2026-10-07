import {
  ALARM_BATCH_LIMIT,
  ALARM_BUDGET_MS,
  RESULT_RETENTION_MS,
} from "./contracts.ts";

// Only scheduling metadata; payloads stay outside the DO.
export class WorkBudget {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS terminal (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
  }
  add(id: string, at = Date.now()): void {
    this.storage.sql.exec(
      "INSERT INTO work VALUES (?,0,?) ON CONFLICT(id) DO UPDATE SET next_at=min(next_at,excluded.next_at)",
      id,
      at,
    );
  }
  async commit(change: () => void): Promise<void> {
    // SQLite transactions include SQL and asynchronous alarm storage together.
    // This transaction contains only local storage, never external I/O.
    await this.storage.transaction(async () => {
      change();
      await this.schedule();
    });
  }
  done(id: string): void {
    this.storage.sql.exec("DELETE FROM work WHERE id=?", id);
  }
  terminal(id: string): void {
    this.done(id);
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO terminal VALUES (?,?)",
      id,
      Date.now() + RESULT_RETENTION_MS,
    );
  }
  retry(id: string): void {
    this.storage.sql.exec(
      "UPDATE work SET attempts=attempts+1, next_at=? + min(30000,1000*(1 << min(attempts,5))) WHERE id=?",
      Date.now(),
      id,
    );
  }
  due(): string[] {
    return this.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM work WHERE next_at<=? ORDER BY CASE id WHEN 'fence' THEN 0 WHEN 'initialization' THEN 1 WHEN 'cleanup' THEN 2 ELSE 3 END,next_at,id LIMIT ?",
        Date.now(),
        ALARM_BATCH_LIMIT,
      )
      .toArray()
      .map((row) => row.id);
  }
  prune(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM operations WHERE id IN (SELECT id FROM terminal WHERE expires_at<=?) AND status!='pending'",
        Date.now(),
      );
      this.storage.sql.exec(
        "DELETE FROM management WHERE id IN (SELECT id FROM terminal WHERE expires_at<=?) AND status='enforced'",
        Date.now(),
      );
      this.storage.sql.exec(
        "DELETE FROM terminal WHERE expires_at<=?",
        Date.now(),
      );
    });
  }
  async schedule(): Promise<void> {
    const next = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT min(at) AS at FROM (SELECT min(next_at) AS at FROM work UNION ALL SELECT min(expires_at) AS at FROM terminal)",
      )
      .one().at;
    if (next === null) {
      await this.storage.deleteAlarm();
      return;
    }
    const at = Math.max(Date.now() + 1_000, next);
    const existing = await this.storage.getAlarm();
    if (existing !== at) await this.storage.setAlarm(at);
  }
  static remaining(start: number): number {
    return Math.max(1, ALARM_BUDGET_MS - (Date.now() - start));
  }
}
