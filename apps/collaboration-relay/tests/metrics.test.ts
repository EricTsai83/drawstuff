import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RELAY_CLOSE_CODES } from "@drawstuff/collaboration/relay-protocol";

import {
  createRelayMetrics,
  relayCloseReasonForCode,
  type RelayMetricsSources,
} from "../src/metrics.ts";

/**
 * Plan 24: the exposition is what an alert queries, so what is asserted here is
 * the shape an alert depends on — every series present from the first scrape,
 * every disconnect reason separable, cumulative histogram buckets, and no label
 * that could name a room or a user.
 */

const sources = (
  overrides: Partial<RelayMetricsSources> = {},
): RelayMetricsSources => ({
  connections: () => 0,
  rooms: () => 0,
  roomSizes: () => [],
  sessions: () => 0,
  revocationCutoffs: () => 0,
  trackedSubjects: () => 0,
  draining: () => false,
  residentMemoryBytes: () => 0,
  heapUsedBytes: () => 0,
  droppedLogRecords: () => 0,
  rejectedLogFields: () => 0,
  limits: {
    maxConnections: 256,
    maxRooms: 128,
    maxConnectionsPerRoom: 32,
    maxTrackedSubjects: 1_024,
  },
  ...overrides,
});

/**
 * The committed `/metrics` example Plan 24's verification requires. It is a real
 * capture, so its *values* are machine- and run-specific; only its shape is
 * asserted against the code.
 */
const SAMPLE_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "observability",
  "relay-metrics-sample.txt",
);

/** `name type` for every family, which is the part a scraper contracts on. */
const familyTypes = (exposition: string): string[] =>
  [
    ...new Set(
      exposition
        .split("\n")
        .filter((line) => line.startsWith("# TYPE "))
        .map((line) => line.slice("# TYPE ".length)),
    ),
  ].sort();

/** Reads one sample by its exact name-and-labels prefix. */
const sample = (exposition: string, selector: string): number | undefined => {
  const line = exposition
    .split("\n")
    .find((candidate) => candidate.startsWith(`${selector} `));
  return line === undefined
    ? undefined
    : Number(line.slice(selector.length + 1));
};

describe("relay metrics exposition", () => {
  it("declares HELP and TYPE for every family and ends with a newline", () => {
    const exposition = createRelayMetrics({ sources: sources() }).render();
    const families = new Set(
      exposition
        .split("\n")
        .filter((line) => line.startsWith("# TYPE "))
        .map((line) => line.split(" ")[2]),
    );
    expect(families.size).toBeGreaterThan(0);
    for (const family of families) {
      expect(exposition).toContain(`# HELP ${family} `);
    }
    // Prometheus requires a trailing newline on the last sample line.
    expect(exposition.endsWith("\n")).toBe(true);
    expect(exposition).not.toContain("\n\n");
  });

  it("pre-registers every disconnect reason at zero", () => {
    // An absent series and a zero series read the same in a dashboard but not in
    // an alert: `rate()` over a series that never appeared yields no data, so a
    // "no disconnects of this kind" condition would evaluate to nothing.
    const exposition = createRelayMetrics({ sources: sources() }).render();
    for (const reason of Object.keys(RELAY_CLOSE_CODES)) {
      expect(
        sample(
          exposition,
          `relay_connections_closed_total{reason="${reason}"}`,
        ),
      ).toBe(0);
    }
    for (const reason of [
      "normalClosure",
      "heartbeatTimeout",
      "peerClosed",
      "shutdown",
      "other",
    ]) {
      expect(
        sample(
          exposition,
          `relay_connections_closed_total{reason="${reason}"}`,
        ),
      ).toBe(0);
    }
  });

  it("keeps SLO section 6's capacity close codes separable", () => {
    const metrics = createRelayMetrics({ sources: sources() });
    // These six are the judgement data for the unexpected-disconnect SLO, so
    // collapsing any pair of them would make the SLO unmeasurable.
    for (const code of [
      RELAY_CLOSE_CODES.rateLimited,
      RELAY_CLOSE_CODES.idleTimeout,
      RELAY_CLOSE_CODES.relayRoomsAtCapacity,
      RELAY_CLOSE_CODES.slowConsumer,
      RELAY_CLOSE_CODES.relayAtCapacity,
      RELAY_CLOSE_CODES.roomAtCapacity,
    ]) {
      metrics.connectionClosed(relayCloseReasonForCode(code));
    }
    const exposition = metrics.render();
    for (const reason of [
      "rateLimited",
      "idleTimeout",
      "relayRoomsAtCapacity",
      "slowConsumer",
      "relayAtCapacity",
      "roomAtCapacity",
    ]) {
      expect(
        sample(
          exposition,
          `relay_connections_closed_total{reason="${reason}"}`,
        ),
      ).toBe(1);
    }
  });

  it("maps a client's own goodbye and an unknown code apart from relay closes", () => {
    expect(relayCloseReasonForCode(1000)).toBe("normalClosure");
    expect(relayCloseReasonForCode(1006)).toBe("other");
    expect(relayCloseReasonForCode(RELAY_CLOSE_CODES.idleTimeout)).toBe(
      "idleTimeout",
    );
  });

  it("counts histogram buckets cumulatively with a +Inf total", () => {
    const metrics = createRelayMetrics({ sources: sources() });
    metrics.observeRoutingLatencySeconds(0.0002);
    metrics.observeRoutingLatencySeconds(0.003);
    metrics.observeRoutingLatencySeconds(10);
    const exposition = metrics.render();

    expect(
      sample(exposition, 'relay_routing_latency_seconds_bucket{le="0.0001"}'),
    ).toBe(0);
    expect(
      sample(exposition, 'relay_routing_latency_seconds_bucket{le="0.00025"}'),
    ).toBe(1);
    expect(
      sample(exposition, 'relay_routing_latency_seconds_bucket{le="0.005"}'),
    ).toBe(2);
    // Out of range: counted in the total but in no bounded bucket.
    expect(
      sample(exposition, 'relay_routing_latency_seconds_bucket{le="0.1"}'),
    ).toBe(2);
    expect(
      sample(exposition, 'relay_routing_latency_seconds_bucket{le="+Inf"}'),
    ).toBe(3);
    expect(sample(exposition, "relay_routing_latency_seconds_count")).toBe(3);
    expect(sample(exposition, "relay_routing_latency_seconds_sum")).toBeCloseTo(
      10.0032,
      6,
    );
  });

  it("counts routed and delivered traffic per channel", () => {
    const metrics = createRelayMetrics({ sources: sources() });
    metrics.frameRouted("scene", 512);
    metrics.frameRouted("presence", 64);
    metrics.frameDelivered("scene", 512);
    metrics.frameDelivered("scene", 512);
    metrics.presenceFrameDropped();
    const exposition = metrics.render();

    expect(
      sample(exposition, 'relay_frames_routed_total{channel="scene"}'),
    ).toBe(1);
    expect(
      sample(exposition, 'relay_routed_bytes_total{channel="scene"}'),
    ).toBe(512);
    expect(
      sample(exposition, 'relay_routed_bytes_total{channel="presence"}'),
    ).toBe(64);
    // Fanout amplification is visible: one routed frame, two writes.
    expect(
      sample(exposition, 'relay_frames_delivered_total{channel="scene"}'),
    ).toBe(2);
    expect(
      sample(exposition, 'relay_delivered_bytes_total{channel="scene"}'),
    ).toBe(1_024);
    expect(sample(exposition, "relay_presence_frames_dropped_total")).toBe(1);
  });

  it("publishes occupancy with the approved limit beside it", () => {
    // Utilization is a query over both, not a number the relay computes: a
    // pre-divided ratio cannot be re-derived once a limit changes.
    const exposition = createRelayMetrics({
      sources: sources({
        connections: () => 48,
        rooms: () => 12,
        sessions: () => 44,
        trackedSubjects: () => 9,
        revocationCutoffs: () => 2,
      }),
    }).render();

    expect(sample(exposition, "relay_connections")).toBe(48);
    expect(sample(exposition, "relay_connections_limit")).toBe(256);
    expect(sample(exposition, "relay_rooms")).toBe(12);
    expect(sample(exposition, "relay_rooms_limit")).toBe(128);
    expect(sample(exposition, "relay_room_members_limit")).toBe(32);
    expect(sample(exposition, "relay_sessions")).toBe(44);
    expect(sample(exposition, "relay_revocation_cutoffs")).toBe(2);
    expect(sample(exposition, "relay_tracked_subjects")).toBe(9);
    expect(sample(exposition, "relay_tracked_subjects_limit")).toBe(1_024);
  });

  it("reports room shape as a size distribution and never as room ids", () => {
    const exposition = createRelayMetrics({
      sources: sources({ roomSizes: () => [1, 2, 2, 4, 9, 32] }),
    }).render();

    expect(sample(exposition, 'relay_rooms_by_member_count{members="1"}')).toBe(
      1,
    );
    expect(sample(exposition, 'relay_rooms_by_member_count{members="2"}')).toBe(
      2,
    );
    expect(
      sample(exposition, 'relay_rooms_by_member_count{members="3-4"}'),
    ).toBe(1);
    expect(
      sample(exposition, 'relay_rooms_by_member_count{members="5-8"}'),
    ).toBe(0);
    expect(
      sample(exposition, 'relay_rooms_by_member_count{members="9-16"}'),
    ).toBe(1);
    expect(
      sample(exposition, 'relay_rooms_by_member_count{members="17-32"}'),
    ).toBe(1);
    expect(
      sample(exposition, 'relay_rooms_by_member_count{members="33+"}'),
    ).toBe(0);
    expect(sample(exposition, "relay_room_members_max")).toBe(32);
  });

  it("uses only closed-set label names, so scrape cardinality is bounded", () => {
    const metrics = createRelayMetrics({
      sources: sources({ roomSizes: () => [3] }),
    });
    metrics.frameRouted("scene", 1);
    metrics.connectionClosed("peerClosed");
    metrics.controlRequest("applied");
    const labelNames = new Set(
      [...metrics.render().matchAll(/^[a-z_]+\{([a-z]+)=/gm)].map(
        (match) => match[1],
      ),
    );
    expect([...labelNames].sort()).toEqual([
      "channel",
      "le",
      "members",
      "outcome",
      "reason",
    ]);
  });

  it("keeps the committed /metrics example in step with the exposition", () => {
    // The example in `docs/observability/` is regenerated by hand, so without
    // this it silently rots the moment a family is added, removed or retyped —
    // and it is the artifact Plan 24's verification points at for the threat
    // model §5 cross-check. Values are deliberately not compared: they are a real
    // capture, so RSS and timings differ every run.
    expect(familyTypes(readFileSync(SAMPLE_PATH, "utf8"))).toEqual(
      familyTypes(createRelayMetrics({ sources: sources() }).render()),
    );
  });

  it("reports draining as a gauge so a scrape explains an unhealthy probe", () => {
    let draining = false;
    const metrics = createRelayMetrics({
      sources: sources({ draining: () => draining }),
    });
    expect(sample(metrics.render(), "relay_draining")).toBe(0);
    draining = true;
    expect(sample(metrics.render(), "relay_draining")).toBe(1);
  });
});
