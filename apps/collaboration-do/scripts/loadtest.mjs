#!/usr/bin/env node
/**
 * Capacity / latency load harness for the collaboration room runtime.
 * Points at any deployed or local collaboration Worker and produces one
 * machine-readable report per run.
 *
 * The harness generates diagnostic measurements; it deliberately embeds no
 * production-capacity claim or pass/fail threshold. Callers may use it to
 * investigate observed load, but a successful run is not a supported-member
 * guarantee.
 *
 * Every synthetic member is a real `ws` client: it joins with a real signed
 * token, keepalives on the production cadence
 * (`KEEPALIVE_INTERVAL_MS`, so hibernation behaves as it would for real
 * clients), publishes opaque payloads with an embedded send timestamp, and
 * records end-to-end delivery latency on every receiver. All clients live in
 * one process, so send/receive clocks are identical by construction.
 *
 * Failure policy mirrors the client contract: an `overloaded`/503 upgrade
 * refusal is recorded and never retried; only `reconnect-storm` reconnects,
 * through its own bounded loop.
 *
 * Usage:
 *   COLLAB_JOIN_TOKEN_SECRET=... \
 *   pnpm --filter @drawstuff/collaboration-do loadtest <base-url> [flags]
 *
 * Flags (all optional):
 *   --members N            room size                        (default 8)
 *   --editors N            members publishing scene frames  (default 1)
 *   --scene-hz N           scene cadence per editor         (default 60)
 *   --presence-hz N        presence cadence per member      (default 30)
 *   --scene-bytes N        scene payload bytes              (default 1024)
 *   --presence-bytes N     presence payload bytes           (default 256)
 *   --duration-s N         measured window                  (default 30)
 *   --mode M               sustained | idle | join-storm | reconnect-storm
 *   --receiver-mode M      healthy | presence-backpressured | scene-slow-consumer
 *                          (applied to the last non-editor member)
 *   --generation N         authorization generation         (default 1)
 *   --room ID              reuse a room id (defaults to a fresh synthetic id)
 *   --json PATH            also write the report as JSON
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { WebSocket } from "ws";

import { KEEPALIVE_INTERVAL_MS } from "@drawstuff/collaboration/client-pacing";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  encodeRelayDataFrame,
  parseRelayServerControl,
  RELAY_KEEPALIVE_REQUEST,
} from "@drawstuff/collaboration/relay-protocol";
import { createRoomTokenId } from "@drawstuff/collaboration/room-token";

import {
  issueSyntheticJoinToken,
  messageBytes,
  roomSocketUrl,
  SMOKE_ORIGIN,
} from "./ws-harness.mjs";

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    members: { type: "string", default: "8" },
    editors: { type: "string", default: "1" },
    "scene-hz": { type: "string", default: "60" },
    "presence-hz": { type: "string", default: "30" },
    "scene-bytes": { type: "string", default: "1024" },
    "presence-bytes": { type: "string", default: "256" },
    "duration-s": { type: "string", default: "30" },
    mode: { type: "string", default: "sustained" },
    "receiver-mode": { type: "string", default: "healthy" },
    generation: { type: "string", default: "1" },
    room: { type: "string" },
    json: { type: "string" },
  },
});

const base = positionals[0];
if (!base) {
  console.error("usage: pnpm --filter @drawstuff/collaboration-do loadtest <base-url> [flags]");
  process.exit(2);
}
const target = base.replace(/\/+$/, "");
const secret = process.env.COLLAB_JOIN_TOKEN_SECRET;
if (!secret) {
  console.error("COLLAB_JOIN_TOKEN_SECRET is required to sign join tokens");
  process.exit(2);
}

const config = {
  target,
  members: Number(flags.members),
  editors: Number(flags.editors),
  sceneHz: Number(flags["scene-hz"]),
  presenceHz: Number(flags["presence-hz"]),
  sceneBytes: Math.max(16, Number(flags["scene-bytes"])),
  presenceBytes: Math.max(16, Number(flags["presence-bytes"])),
  durationS: Number(flags["duration-s"]),
  mode: flags.mode,
  receiverMode: flags["receiver-mode"],
  generation: Number(flags.generation),
};
if (!["sustained", "idle", "join-storm", "reconnect-storm"].includes(config.mode)) {
  console.error(`unknown --mode: ${config.mode}`);
  process.exit(2);
}
if (
  !["healthy", "presence-backpressured", "scene-slow-consumer"].includes(
    config.receiverMode,
  )
) {
  console.error(`unknown --receiver-mode: ${config.receiverMode}`);
  process.exit(2);
}

const roomId = roomIdSchema.parse(
  flags.room ??
    `load-${Date.now().toString(36)}-${createRoomTokenId().slice(0, 8)}`,
);

const issueToken = (subject, role) =>
  issueSyntheticJoinToken({
    roomId,
    secret,
    subject,
    role,
    authGeneration: config.generation,
  });

/** Opaque payload with an embedded send stamp: [f64 sentAt][u32 seq][fill]. */
const buildPayload = (bytes, seq) => {
  const payload = new Uint8Array(bytes);
  const view = new DataView(payload.buffer);
  view.setFloat64(0, Date.now());
  view.setUint32(8, seq >>> 0);
  return payload;
};
const sentAtOf = (payload) =>
  payload.byteLength >= 8
    ? new DataView(payload.buffer, payload.byteOffset).getFloat64(0)
    : undefined;

/** Nearest-rank percentile: the smallest value at or above rank q*N. Using
 *  `floor` here would return the next rank whenever `q * N` is integral —
 *  p99 of 100 samples would report the maximum. */
const percentile = (sorted, q) =>
  sorted.length === 0
    ? undefined
    : sorted[
        Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
      ];
const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
  };
};

// ---------------------------------------------------------------------------
// Shared run state
// ---------------------------------------------------------------------------

const metrics = {
  upgradeMs: [], // socket open (gateway Upgrade + routing)
  joinAckMs: [], // join frame -> joined ack (Object handling)
  sceneLatencyMs: [], // sender stamp -> receiver delivery
  presenceLatencyMs: [],
  sceneSent: 0,
  presenceSent: 0,
  sceneReceived: 0,
  presenceReceived: 0,
  upgradeRefusals: {}, // status -> count
  closes: {}, // close code -> count
  reconnects: 0,
  sendErrors: 0,
};
const countInto = (record, key) => {
  record[key] = (record[key] ?? 0) + 1;
};

/** One synthetic member. */
function connectMember(index, role) {
  const url = roomSocketUrl(target, roomId, config.generation);
  const startedAt = Date.now();
  const socket = new WebSocket(url, { headers: { Origin: SMOKE_ORIGIN } });
  socket.binaryType = "arraybuffer";
  const member = {
    index,
    role,
    socket,
    upgraded: false,
    upgradeRefused: false,
    joined: false,
    closed: undefined,
    timers: [],
    /** Set while this member's TCP stream is deliberately paused. */
    pausedStream: undefined,
  };

  socket.on("open", () => {
    member.upgraded = true;
    metrics.upgradeMs.push(Date.now() - startedAt);
    const joinSentAt = Date.now();
    socket.send(
      encodeRelayControl({
        control: "join",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId,
        token: issueToken(`load-${index}-${createRoomTokenId().slice(0, 6)}`, role),
      }),
    );
    member.joinAckStart = joinSentAt;
  });
  socket.on("unexpected-response", (_request, response) => {
    countInto(metrics.upgradeRefusals, String(response.statusCode));
    // Terminal for this slot: the client contract forbids retrying an
    // overload, and reconnecting into one would amplify the very condition
    // the run is measuring.
    member.upgradeRefused = true;
    socket.terminate();
  });
  socket.on("error", () => {
    // The close event (or the refusal above) carries the observable outcome.
  });
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = messageBytes(data).toString("utf8");
      const control = parseRelayServerControl(text);
      if (control?.control === "joined" && member.joinAckStart !== undefined) {
        metrics.joinAckMs.push(Date.now() - member.joinAckStart);
        member.joined = true;
      }
      return;
    }
    const bytes = new Uint8Array(messageBytes(data));
    const channel = bytes[0] === 0x01 ? "scene" : bytes[0] === 0x02 ? "presence" : undefined;
    if (channel === undefined) return;
    const sentAt = sentAtOf(bytes.subarray(1));
    if (channel === "scene") {
      metrics.sceneReceived += 1;
      if (sentAt !== undefined) metrics.sceneLatencyMs.push(Date.now() - sentAt);
    } else {
      metrics.presenceReceived += 1;
      if (sentAt !== undefined) metrics.presenceLatencyMs.push(Date.now() - sentAt);
    }
  });
  socket.on("close", (code) => {
    member.closed = code;
    // Only sockets that actually became sessions contribute a close code. A
    // refused upgrade makes `ws` emit a synthetic 1006 for a socket that
    // never opened; counting it would double-report the refusal (already in
    // `upgradeRefusals`) as a disconnect verdict.
    if (member.upgraded) countInto(metrics.closes, String(code));
    for (const timer of member.timers) clearInterval(timer);
  });
  return member;
}

const send = (member, frame) => {
  if (member.socket.readyState !== WebSocket.OPEN) return false;
  try {
    member.socket.send(frame);
    return true;
  } catch {
    metrics.sendErrors += 1;
    return false;
  }
};

const startCadences = (member) => {
  // Production keepalive cadence, so hibernation and liveness behave exactly
  // as they would for real clients.
  member.timers.push(
    setInterval(() => send(member, RELAY_KEEPALIVE_REQUEST), KEEPALIVE_INTERVAL_MS),
  );
  if (config.mode === "idle") return;
  const isEditor = member.index < config.editors;
  if (isEditor && config.sceneHz > 0) {
    let seq = 0;
    member.timers.push(
      setInterval(() => {
        if (
          send(
            member,
            encodeRelayDataFrame("scene", buildPayload(config.sceneBytes, (seq += 1))),
          )
        ) {
          metrics.sceneSent += 1;
        }
      }, 1_000 / config.sceneHz),
    );
  }
  if (config.presenceHz > 0) {
    let seq = 0;
    member.timers.push(
      setInterval(() => {
        if (
          send(
            member,
            encodeRelayDataFrame(
              "presence",
              buildPayload(config.presenceBytes, (seq += 1)),
            ),
          )
        ) {
          metrics.presenceSent += 1;
        }
      }, 1_000 / config.presenceHz),
    );
  }
};

/**
 * Degrades one receiver by pausing its TCP stream, building server-side
 * outbound buffer: cyclically for presence backpressure, permanently for the
 * slow-consumer verdict.
 *
 * The paused stream is tracked *on the member* so it can be resumed before
 * that member is terminated — whether at teardown or at a reconnect-storm
 * replacement. A permanently paused socket cannot read the server's close
 * frame either, so the 4003 slow-consumer verdict would otherwise be lost and
 * recorded as a 1006 transport drop: the exact number this mode measures.
 */
const degradeReceiver = (member) => {
  const stream = member.socket._socket;
  if (stream === undefined) return;
  if (config.receiverMode === "scene-slow-consumer") {
    stream.pause();
    member.pausedStream = stream;
    return;
  }
  member.timers.push(
    setInterval(() => {
      stream.pause();
      setTimeout(() => stream.resume(), 1_000);
    }, 1_250),
  );
};

/** Stops a member's load and lets any queued server frames — above all a
 *  close verdict — reach it. Idempotent. */
const releaseMember = (member) => {
  for (const timer of member.timers) clearInterval(timer);
  member.timers.length = 0;
  if (member.pausedStream !== undefined) {
    member.pausedStream.resume();
    member.pausedStream = undefined;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(
  `loadtest: room=${roomId} mode=${config.mode} members=${config.members} editors=${config.editors} ` +
    `scene=${config.sceneHz}Hz/${config.sceneBytes}B presence=${config.presenceHz}Hz/${config.presenceBytes}B ` +
    `receiver=${config.receiverMode} duration=${config.durationS}s`,
);

const members = [];
const roleOf = (index) => (index < config.editors ? "editor" : "viewer");

if (config.mode === "join-storm") {
  // Every upgrade in the same tick: the storm is the point.
  for (let index = 0; index < config.members; index += 1) {
    members.push(connectMember(index, roleOf(index)));
  }
} else {
  for (let index = 0; index < config.members; index += 1) {
    members.push(connectMember(index, roleOf(index)));
    await sleep(50);
  }
}

/**
 * Waits (bounded) for a cohort to finish joining, then starts its publish and
 * keepalive cadences and re-applies the receiver degradation. Used for the
 * initial cohort *and* for every reconnect-storm replacement: a replacement
 * that never resumed its cadences would turn the rest of the run into idle
 * upgrade churn instead of the configured workload.
 */
const activateCohort = async (cohort, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    cohort.some((m) => !m.joined && m.closed === undefined)
  ) {
    await sleep(100);
  }
  for (const member of cohort) {
    if (!member.joined) continue;
    startCadences(member);
  }
  if (config.receiverMode !== "healthy") {
    const degraded = cohort.findLast(
      (m) => m.joined && m.index >= config.editors,
    );
    if (degraded) degradeReceiver(degraded);
  }
  return cohort.filter((m) => m.joined).length;
};

const joinedCount = await activateCohort(members);
console.log(`joined ${joinedCount}/${config.members}`);

const measuredStart = Date.now();
if (config.mode === "reconnect-storm") {
  // Each member repeatedly drops without a leave and rejoins, for the whole
  // window — the shape a deploy or a flaky network produces.
  const deadline = measuredStart + config.durationS * 1_000;
  // Slots whose upgrade was refused are retired rather than reconnected:
  // `overloaded` is explicitly not retryable, and hammering a Worker that
  // just refused would amplify the condition instead of measuring it.
  const retiredSlots = new Set();
  while (Date.now() < deadline) {
    await sleep(1_000);
    // Re-checked after the sleep: the window may have closed while waiting,
    // and a replacement round started now would run load (and its activation
    // wait) past the measured window it is supposed to describe.
    if (Date.now() >= deadline) break;

    const replacing = [];
    for (const [slot, member] of members.entries()) {
      if (retiredSlots.has(slot)) continue;
      if (member.upgradeRefused) {
        retiredSlots.add(slot);
        continue;
      }
      // Release first, terminate second, so a member holding an unread
      // server close (a slow consumer's 4003) can still record its verdict.
      releaseMember(member);
      replacing.push([slot, member]);
    }
    if (replacing.length === 0) break;
    await sleep(100);

    const replacements = [];
    for (const [slot, member] of replacing) {
      if (member.closed === undefined) member.socket.terminate();
      const replacement = connectMember(member.index, roleOf(member.index));
      members[slot] = replacement;
      replacements.push(replacement);
      metrics.reconnects += 1;
    }
    // The replacements carry the configured workload for the rest of the
    // window; without this the run measures reconnect churn against an
    // otherwise silent room. Activation is capped by the time left, so the
    // measured window stays what `--duration-s` asked for.
    await activateCohort(
      replacements,
      Math.max(0, Math.min(5_000, deadline - Date.now())),
    );
  }
  if (retiredSlots.size > 0) {
    console.log(
      `retired ${retiredSlots.size} slot(s) after an upgrade refusal (not retried)`,
    );
  }
} else {
  await sleep(config.durationS * 1_000);
}
const measuredMs = Date.now() - measuredStart;

// Release before the leave frames: a degraded receiver may already be holding
// an unread server close (the 4003 verdict this mode measures), and reading
// it is only possible while the stream flows.
for (const member of members) releaseMember(member);
await sleep(500);
for (const member of members) {
  if (member.closed === undefined) {
    send(member, encodeRelayControl({ control: "leave" }));
  }
}
await sleep(1_000);
for (const member of members) member.socket.terminate();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalSent = metrics.sceneSent + metrics.presenceSent;
const totalReceived = metrics.sceneReceived + metrics.presenceReceived;
const report = {
  config,
  roomId,
  measuredMs,
  joined: joinedCount,
  upgrade: summarize(metrics.upgradeMs),
  joinAck: summarize(metrics.joinAckMs),
  scene: {
    sent: metrics.sceneSent,
    received: metrics.sceneReceived,
    latencyMs: summarize(metrics.sceneLatencyMs),
    throughputPerS: metrics.sceneReceived / (measuredMs / 1_000),
  },
  presence: {
    sent: metrics.presenceSent,
    received: metrics.presenceReceived,
    latencyMs: summarize(metrics.presenceLatencyMs),
    throughputPerS: metrics.presenceReceived / (measuredMs / 1_000),
  },
  fanoutAmplification: totalSent === 0 ? undefined : totalReceived / totalSent,
  upgradeRefusals: metrics.upgradeRefusals,
  closes: metrics.closes,
  reconnects: metrics.reconnects,
  sendErrors: metrics.sendErrors,
};

console.log(JSON.stringify(report, null, 2));
if (flags.json) {
  writeFileSync(flags.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report written to ${flags.json}`);
}
process.exit(0);
