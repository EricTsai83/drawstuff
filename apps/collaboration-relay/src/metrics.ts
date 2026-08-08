import type { MessageChannel } from "@drawstuff/collaboration/protocol";
import { RELAY_CLOSE_CODES } from "@drawstuff/collaboration/relay-protocol";

/**
 * Relay metrics in Prometheus text format.
 *
 * Hand-written rather than `prom-client`. The relay exposes about twenty series
 * and needs exactly three line shapes from the exposition format; a new
 * production dependency inside the process that terminates every collaboration
 * socket is not proportionate to that. If an audit later requires a client
 * library, that is its own decision with its own recorded reason.
 *
 * Nothing here can carry collaboration content, and that is structural rather
 * than careful: the relay never decodes a payload, and every label value in this
 * file comes from a closed set declared in code — the two channel names and the
 * published close-reason names. No caller-supplied string reaches the
 * exposition, so cardinality is bounded by construction.
 *
 * Room ids are absent even though
 * `docs/architecture/collaboration-threat-model.md` §5 would permit them:
 * a per-room series would publish the room list to anything that can read the
 * endpoint *and* grow without bound as rooms churn. Room shape is exposed as a
 * size distribution instead, which answers the capacity question without naming
 * anything.
 */

/** Prometheus text exposition, version 0.0.4. */
export const RELAY_METRICS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

const CHANNELS: readonly MessageChannel[] = ["scene", "presence"];

/**
 * Disconnect-reason labels. `RELAY_CLOSE_CODES` supplies one per published
 * code — SLO §6 judges `rateLimited`, `idleTimeout`, `relayRoomsAtCapacity`,
 * `slowConsumer`, `relayAtCapacity` and `roomAtCapacity` individually, so they
 * must never be collapsed — plus the closes that carry no relay code:
 * a client's own goodbye, a missed heartbeat, a socket the peer dropped, and
 * process shutdown.
 */
export type RelayCloseReason =
  | keyof typeof RELAY_CLOSE_CODES
  | "normalClosure"
  | "heartbeatTimeout"
  | "peerClosed"
  | "shutdown"
  | "other";

const CLOSE_REASON_BY_CODE = new Map<number, RelayCloseReason>(
  Object.entries(RELAY_CLOSE_CODES).map(([name, code]) => [
    code,
    name as keyof typeof RELAY_CLOSE_CODES,
  ]),
);

const ALL_CLOSE_REASONS: readonly RelayCloseReason[] = [
  ...(Object.keys(RELAY_CLOSE_CODES) as (keyof typeof RELAY_CLOSE_CODES)[]),
  "normalClosure",
  "heartbeatTimeout",
  "peerClosed",
  "shutdown",
  "other",
];

/**
 * Maps a close code to its reason label. Exhaustive by construction: a code
 * added to `RELAY_CLOSE_CODES` gets its own label without an edit here, so a new
 * disconnect cause can never be silently folded into an existing bucket.
 */
export function relayCloseReasonForCode(code: number): RelayCloseReason {
  return (
    CLOSE_REASON_BY_CODE.get(code) ??
    (code === 1000 ? "normalClosure" : "other")
  );
}

/** Control-endpoint outcomes, kept coarse: no token or claim value is a label. */
export type RelayControlOutcome =
  "applied" | "unauthorized" | "rejected" | "failed";

const CONTROL_OUTCOMES: readonly RelayControlOutcome[] = [
  "applied",
  "unauthorized",
  "rejected",
  "failed",
];

/**
 * Routing-latency buckets, in seconds, straddling the SLO §3.1 thresholds
 * (p50 ≤ 1 ms, p95 ≤ 5 ms, p99 ≤ 20 ms) with headroom on both sides. Bounded
 * and cumulative: the histogram keeps counts, never samples, so the memory cost
 * is fixed regardless of traffic and a windowed quantile is a query
 * (`histogram_quantile` over `rate`) rather than retained state.
 */
const ROUTING_LATENCY_BUCKETS: readonly number[] = [
  0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1,
];

/**
 * Event-loop lag buckets, in seconds, straddling SLO §4.2 (p95 ≤ 20 ms,
 * p99 ≤ 50 ms, alert on 30 s of p99 > 100 ms).
 */
const EVENT_LOOP_LAG_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1,
];

/**
 * Room-size distribution buckets. Upper bound 32 is `maxConnectionsPerRoom`;
 * the `33+` bucket exists so the series stays total even if that limit is
 * raised, and reads as a bug report if it is ever non-zero while the limit
 * stands.
 */
const ROOM_SIZE_BUCKETS: readonly { label: string; max: number }[] = [
  { label: "1", max: 1 },
  { label: "2", max: 2 },
  { label: "3-4", max: 4 },
  { label: "5-8", max: 8 },
  { label: "9-16", max: 16 },
  { label: "17-32", max: 32 },
  { label: "33+", max: Number.POSITIVE_INFINITY },
];

type LabelValues = Readonly<Record<string, string>>;

/** Label values are closed-set identifiers, but escaping is still cheap. */
const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const renderLabels = (labels: LabelValues): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${rendered}}`;
};

/** Integers stay integers so the exposition stays readable and diffable. */
const renderValue = (value: number): string =>
  Number.isInteger(value) ? value.toFixed(0) : String(value);

type Counter = {
  inc(labels: LabelValues, delta?: number): void;
  render(): string[];
};

/**
 * Series are pre-registered at zero rather than created on first observation.
 * An absent series and a zero series read the same way in a dashboard but not in
 * an alert: `rate(...)` over a series that has never appeared yields no data, so
 * a "no disconnects of this kind" condition would silently evaluate to nothing
 * instead of to zero.
 */
function createCounter(options: {
  name: string;
  help: string;
  series: readonly LabelValues[];
}): Counter {
  const values = new Map<string, { labels: LabelValues; value: number }>();
  const keyOf = (labels: LabelValues): string => renderLabels(labels);
  for (const labels of options.series) {
    values.set(keyOf(labels), { labels, value: 0 });
  }
  return {
    inc(labels, delta = 1) {
      const key = keyOf(labels);
      const existing = values.get(key);
      if (existing) {
        existing.value += delta;
        return;
      }
      values.set(key, { labels, value: delta });
    },
    render() {
      const lines = [
        `# HELP ${options.name} ${options.help}`,
        `# TYPE ${options.name} counter`,
      ];
      for (const { labels, value } of values.values()) {
        lines.push(
          `${options.name}${renderLabels(labels)} ${renderValue(value)}`,
        );
      }
      return lines;
    },
  };
}

type Histogram = {
  observe(value: number): void;
  render(): string[];
};

function createHistogram(options: {
  name: string;
  help: string;
  buckets: readonly number[];
}): Histogram {
  const bounds = [...options.buckets].sort((a, b) => a - b);
  const counts = new Array<number>(bounds.length).fill(0);
  let count = 0;
  let sum = 0;
  return {
    observe(value) {
      count += 1;
      sum += value;
      for (let index = 0; index < bounds.length; index += 1) {
        // Cumulative buckets: a sample lands in its own bucket and every wider
        // one, which is what `histogram_quantile` expects.
        if (value <= (bounds[index] ?? 0))
          counts[index] = (counts[index] ?? 0) + 1;
      }
    },
    render() {
      const lines = [
        `# HELP ${options.name} ${options.help}`,
        `# TYPE ${options.name} histogram`,
      ];
      for (let index = 0; index < bounds.length; index += 1) {
        lines.push(
          `${options.name}_bucket{le="${bounds[index]}"} ${renderValue(counts[index] ?? 0)}`,
        );
      }
      lines.push(`${options.name}_bucket{le="+Inf"} ${renderValue(count)}`);
      lines.push(`${options.name}_sum ${renderValue(sum)}`);
      lines.push(`${options.name}_count ${renderValue(count)}`);
      return lines;
    },
  };
}

const renderSamples = (
  name: string,
  type: "gauge" | "counter",
  help: string,
  samples: readonly { labels?: LabelValues; value: number }[],
): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} ${type}`,
  ...samples.map(
    ({ labels, value }) =>
      `${name}${renderLabels(labels ?? {})} ${renderValue(value)}`,
  ),
];

const renderGauge = (
  name: string,
  help: string,
  samples: readonly { labels?: LabelValues; value: number }[],
): string[] => renderSamples(name, "gauge", help, samples);

/**
 * A counter whose state lives outside this module. Typed `counter` rather than
 * `gauge` because it only ever increases, which is what `rate()` needs.
 */
const renderSourcedCounter = (
  name: string,
  help: string,
  value: number,
): string[] => renderSamples(name, "counter", help, [{ value }]);

/**
 * Live state the exposition samples at scrape time rather than mirroring into
 * counters. Current occupancy is a gauge by nature, and reading it from the
 * owners keeps a single source of truth: a divergence between `relay_rooms` and
 * the fanout's actual map would be indistinguishable from a real capacity
 * problem.
 */
export type RelayMetricsSources = {
  connections(): number;
  rooms(): number;
  /** Member count of every live room, unordered and unlabelled. */
  roomSizes(): readonly number[];
  sessions(): number;
  revocationCutoffs(): number;
  trackedSubjects(): number;
  draining(): boolean;
  residentMemoryBytes(): number;
  heapUsedBytes(): number;
  /** Log records the sink dropped because its stream was backed up. */
  droppedLogRecords(): number;
  /** Log fields the runtime allowlist rejected; non-zero means a code defect. */
  rejectedLogFields(): number;
  /** Approved capacity limits, exposed so a utilization ratio is a query. */
  limits: {
    maxConnections: number;
    maxRooms: number;
    maxConnectionsPerRoom: number;
    maxTrackedSubjects: number;
  };
};

export type RelayMetrics = {
  connectionOpened(): void;
  connectionClosed(reason: RelayCloseReason): void;
  /** An authorized join that reached the fanout. */
  connectionJoined(): void;
  /** A data frame that passed every inbound check and was routed. */
  frameRouted(channel: MessageChannel, byteLength: number): void;
  /** A frame written towards one member's socket. */
  frameDelivered(channel: MessageChannel, byteLength: number): void;
  /** A presence frame dropped because the receiver's buffer was over budget. */
  presenceFrameDropped(): void;
  /** SLO §3.1: receipt of a frame until it reached every other member's send. */
  observeRoutingLatencySeconds(seconds: number): void;
  observeEventLoopLagSeconds(seconds: number): void;
  controlRequest(outcome: RelayControlOutcome): void;
  render(): string;
};

export function createRelayMetrics(options: {
  sources: RelayMetricsSources;
}): RelayMetrics {
  const { sources } = options;

  const connectionsOpened = createCounter({
    name: "relay_connections_opened_total",
    help: "WebSocket connections accepted by the relay process.",
    series: [{}],
  });
  const connectionsClosed = createCounter({
    name: "relay_connections_closed_total",
    help: "Connections closed, by disconnect reason (SLO section 6).",
    series: ALL_CLOSE_REASONS.map((reason) => ({ reason })),
  });
  const joins = createCounter({
    name: "relay_joins_total",
    help: "Authorized joins that reached the room fanout.",
    series: [{}],
  });
  const framesRouted = createCounter({
    name: "relay_frames_routed_total",
    help: "Inbound data frames accepted and routed, by channel.",
    series: CHANNELS.map((channel) => ({ channel })),
  });
  const bytesRouted = createCounter({
    name: "relay_routed_bytes_total",
    help: "Wire bytes of inbound data frames accepted and routed, by channel.",
    series: CHANNELS.map((channel) => ({ channel })),
  });
  const framesDelivered = createCounter({
    name: "relay_frames_delivered_total",
    help: "Data frames written towards a member socket, by channel.",
    series: CHANNELS.map((channel) => ({ channel })),
  });
  const bytesDelivered = createCounter({
    name: "relay_delivered_bytes_total",
    help: "Wire bytes written towards member sockets, by channel.",
    series: CHANNELS.map((channel) => ({ channel })),
  });
  const presenceDropped = createCounter({
    name: "relay_presence_frames_dropped_total",
    help: "Presence frames dropped because the receiver's buffer was over budget.",
    series: [{}],
  });
  const controlRequests = createCounter({
    name: "relay_control_requests_total",
    help: "Control endpoint requests, by outcome.",
    series: CONTROL_OUTCOMES.map((outcome) => ({ outcome })),
  });
  const routingLatency = createHistogram({
    name: "relay_routing_latency_seconds",
    help: "Frame receipt until it reached every other room member's socket send.",
    buckets: ROUTING_LATENCY_BUCKETS,
  });
  const eventLoopLag = createHistogram({
    name: "relay_event_loop_lag_seconds",
    help: "Sampled event-loop delay; the relay's fanout is synchronous.",
    buckets: EVENT_LOOP_LAG_BUCKETS,
  });

  const renderRoomSizes = (): string[] => {
    const sizes = sources.roomSizes();
    const counts = ROOM_SIZE_BUCKETS.map(() => 0);
    let largest = 0;
    for (const size of sizes) {
      if (size > largest) largest = size;
      const index = ROOM_SIZE_BUCKETS.findIndex((bucket) => size <= bucket.max);
      if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
    }
    return [
      ...renderGauge(
        "relay_rooms_by_member_count",
        "Live rooms grouped by member count; no room is named.",
        ROOM_SIZE_BUCKETS.map((bucket, index) => ({
          labels: { members: bucket.label },
          value: counts[index] ?? 0,
        })),
      ),
      ...renderGauge(
        "relay_room_members_max",
        "Member count of the largest live room.",
        [{ value: largest }],
      ),
    ];
  };

  return {
    connectionOpened: () => connectionsOpened.inc({}),
    connectionClosed: (reason) => connectionsClosed.inc({ reason }),
    connectionJoined: () => joins.inc({}),
    frameRouted(channel, byteLength) {
      framesRouted.inc({ channel });
      bytesRouted.inc({ channel }, byteLength);
    },
    frameDelivered(channel, byteLength) {
      framesDelivered.inc({ channel });
      bytesDelivered.inc({ channel }, byteLength);
    },
    presenceFrameDropped: () => presenceDropped.inc({}),
    observeRoutingLatencySeconds: (seconds) => routingLatency.observe(seconds),
    observeEventLoopLagSeconds: (seconds) => eventLoopLag.observe(seconds),
    controlRequest: (outcome) => controlRequests.inc({ outcome }),
    render() {
      const lines = [
        ...renderGauge(
          "relay_connections",
          "Currently open WebSocket connections.",
          [{ value: sources.connections() }],
        ),
        ...renderGauge(
          "relay_connections_limit",
          "Approved relay-wide connection cap (SLO section 2).",
          [{ value: sources.limits.maxConnections }],
        ),
        ...renderGauge("relay_rooms", "Currently live rooms.", [
          { value: sources.rooms() },
        ]),
        ...renderGauge(
          "relay_rooms_limit",
          "Approved room cap (SLO section 2).",
          [{ value: sources.limits.maxRooms }],
        ),
        ...renderGauge(
          "relay_room_members_limit",
          "Approved per-room member cap (SLO section 2).",
          [{ value: sources.limits.maxConnectionsPerRoom }],
        ),
        ...renderRoomSizes(),
        ...renderGauge(
          "relay_sessions",
          "Authorized joined sessions across all room generations.",
          [{ value: sources.sessions() }],
        ),
        ...renderGauge(
          "relay_revocation_cutoffs",
          "Live revocation cutoffs held by the session registry.",
          [{ value: sources.revocationCutoffs() }],
        ),
        ...renderGauge(
          "relay_tracked_subjects",
          "Subjects with a live join-rate budget entry.",
          [{ value: sources.trackedSubjects() }],
        ),
        ...renderGauge(
          "relay_tracked_subjects_limit",
          "Entry cap of the join-rate budget map; at the cap it fails open.",
          [{ value: sources.limits.maxTrackedSubjects }],
        ),
        ...renderGauge(
          "relay_process_resident_memory_bytes",
          "Process resident set size (SLO section 4.1).",
          [{ value: sources.residentMemoryBytes() }],
        ),
        ...renderGauge(
          "relay_process_heap_used_bytes",
          "Process heap in use.",
          [{ value: sources.heapUsedBytes() }],
        ),
        ...renderGauge(
          "relay_draining",
          "1 while the process is draining and reports itself unhealthy.",
          [{ value: sources.draining() ? 1 : 0 }],
        ),
        ...renderSourcedCounter(
          "relay_log_records_dropped_total",
          "Log records dropped because the output stream was backed up.",
          sources.droppedLogRecords(),
        ),
        ...renderSourcedCounter(
          "relay_log_fields_rejected_total",
          "Log fields refused by the field allowlist; non-zero is a code defect.",
          sources.rejectedLogFields(),
        ),
        ...connectionsOpened.render(),
        ...connectionsClosed.render(),
        ...joins.render(),
        ...framesRouted.render(),
        ...bytesRouted.render(),
        ...framesDelivered.render(),
        ...bytesDelivered.render(),
        ...presenceDropped.render(),
        ...controlRequests.render(),
        ...routingLatency.render(),
        ...eventLoopLag.render(),
      ];
      return `${lines.join("\n")}\n`;
    },
  };
}
