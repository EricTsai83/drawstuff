/** Live acceptance diagnostics. Raw platform events stay in memory and are discarded. */
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";

const events = new Set([
  "gateway.unhandled_failure", "authority.entry_failed", "adapter.delivery_failed",
  "gateway.room_fetch_failed", "room.schema_bootstrap_failed", "room.frame_dispatch_failed",
  "room.socket_error", "room.fanout_write_failed", "room.session_joined", "room.session_closed",
]);
const errors = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]);

export function createTailSummary(roomIds) {
  const summary = { source: "wrangler-live-tail", platformEvents: 0, fixtureEvents: {}, unscopedFailures: {}, exceptions: 0, malformedRecords: 0 };
  const increment = (target, key) => { target[key] = (target[key] ?? 0) + 1; };
  const accept = value => {
    if (!value || typeof value !== "object" || !Array.isArray(value.logs)) return;
    summary.platformEvents++;
    // Platform exception text can include secrets. Keep only its count, without claiming fixture attribution.
    summary.exceptions += Array.isArray(value.exceptions) ? value.exceptions.length : 0;
    for (const log of value.logs) for (const message of Array.isArray(log.message) ? log.message : []) {
      let record = message;
      if (typeof message === "string") {
        try { record = JSON.parse(message); } catch { continue; }
      }
      if (!record || typeof record !== "object" || !events.has(record.event)) continue;
      const scoped = roomIds.includes(record.roomId);
      if (!scoped && record.roomId !== undefined) continue;
      if (!scoped && ["room.session_joined", "room.session_closed"].includes(record.event)) continue;
      let key = record.event;
      if (errors.has(record.errorName)) key += `:${record.errorName}`;
      for (const name of ["status", "closeCode"]) {
        if (Number.isInteger(record[name]) && record[name] >= 100 && record[name] <= 4999) key += `:${name}=${record[name]}`;
      }
      increment(scoped ? summary.fixtureEvents : summary.unscopedFailures, key);
    }
  };
  // Wrangler prints consecutive, pretty-printed JSON objects; chunks need not end at object boundaries.
  let buffer = "", depth = 0, quoted = false, escaped = false;
  const feed = chunk => {
    for (const character of chunk.toString()) {
      if (!depth) {
        if (character !== "{") continue;
        buffer = "{"; depth = 1; quoted = false; escaped = false; continue;
      }
      buffer += character;
      if (buffer.length > 1024 * 1024) throw new Error("tail-record-size-limit");
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        try { accept(JSON.parse(buffer)); } catch { summary.malformedRecords++; }
        buffer = "";
      }
    }
  };
  return { summary, feed };
}

export async function startWorkerTail({ workerDir, roomIds, report }) {
  const { summary, feed } = createTailSummary(roomIds);
  const child = spawn("pnpm", ["--filter", "@drawstuff/collaboration-do", "tail:json"], {
    cwd: workerDir, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stopping = false, failed = false, closed = false;
  const signal = name => { try { process.kill(-child.pid, name); } catch { /* Already closed. */ } };
  const fail = () => {
    if (failed || stopping) return;
    failed = true; report("worker-tail-failed"); signal("SIGTERM");
  };
  child.stdout.on("data", chunk => { try { feed(chunk); } catch { fail(); } });
  // Discard CLI stderr; it can contain identifiers and URLs.
  child.stderr.resume();
  child.once("error", fail);
  const completion = new Promise(resolve => child.once("close", code => {
    closed = true; summary.exitCode = code; if (!stopping) fail(); resolve();
  }));
  await pause(8000);
  if (failed || closed) throw new Error("worker-tail-start-failed");
  report("worker-tail-running", { deliveryConfirmed: summary.platformEvents > 0 });
  return {
    failed: () => failed,
    async stop() {
      stopping = true; signal("SIGTERM");
      await Promise.race([completion, pause(5000)]);
      if (!closed) { signal("SIGKILL"); await completion; }
      return { ...summary, unexpectedExit: failed, deliveryConfirmed: summary.platformEvents > 0,
        limitation: "Live tail can sample or drop events; unscoped failures and platform exceptions cannot be attributed to this fixture. No historical log permission." };
    },
  };
}
